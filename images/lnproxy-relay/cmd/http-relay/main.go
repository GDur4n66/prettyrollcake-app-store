package main

import (
	"context"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/lnproxy/lnc"
	"github.com/lnproxy/lnproxy-relay"
)

var lnproxy_relay *relay.Relay

func specApiHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept")

	x := relay.ProxyParameters{}
	err := json.NewDecoder(r.Body).Decode(&x)
	if err != nil {
		log.Println("error decoding request:", err)
		body, err := io.ReadAll(r.Body)
		if err != nil && err != io.EOF {
			log.Println("error reading request:", err)
		} else if len(body) > 0 {
			log.Println("request:", string(body))
		}
		json.NewEncoder(w).Encode(makeJsonError("bad request"))
		return
	}

	proxy_invoice, err := lnproxy_relay.OpenCircuit(x)
	if errors.Is(err, relay.ClientFacing) {
		log.Println("client facing error", strings.TrimSpace(err.Error()), "for", x)
		json.NewEncoder(w).Encode(makeJsonError(strings.TrimSpace(err.Error())))
		return
	} else if err != nil {
		log.Println("internal error", strings.TrimSpace(err.Error()), "for", x)
		json.NewEncoder(w).Encode(makeJsonError("internal error"))
		return
	}

	json.NewEncoder(w).Encode(struct {
		WrappedInvoice string `json:"proxy_invoice"`
	}{
		WrappedInvoice: proxy_invoice,
	})
}

type JsonError struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

func makeJsonError(reason string) JsonError {
	return JsonError{
		Status: "ERROR",
		Reason: reason,
	}
}

func main() {
	fees := registerFeeFlags(flag.CommandLine)
	httpHostFlag := flag.String("host", "localhost", "http host over which to expose api")
	httpPortFlag := flag.String("port", "4747", "http port over which to expose api")
	networkFlag := flag.String("network", "", "bitcoin network shown on the status page, e.g. mainnet or regtest (env: LNPROXY_NETWORK)")
	publicURLFlag := flag.String("public-url", "", "comma-separated addresses clients use, shown on the status page (env: LNPROXY_PUBLIC_URL)")
	dbPathFlag := flag.String("db", "lnproxy-relay.db", "SQLite file for invoice states and events (env: LNPROXY_DB)")
	retentionFlag := flag.Uint64("event-retention-days", 30, "days to keep invoice states and events (env: LNPROXY_EVENT_RETENTION_DAYS)")
	lndHostStringFlag := flag.String("lnd", "https://127.0.0.1:8080", "host for lnd's REST api")
	verifyHostnameFlag := flag.Bool("lnd-tls-verify-hostname", true,
		"check that lnd's certificate names the -lnd host; false still pins -lnd-cert (env: LNPROXY_LND_TLS_VERIFY_HOSTNAME)")
	lndCertPathFlag := flag.String(
		"lnd-cert",
		".lnd/tls.cert",
		"lnd's self-signed cert (set to empty string for no-rest-tls=true)",
	)

	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), `usage: %s [flags] lnproxy.macaroon
  lnproxy.macaroon
	Path to lnproxy macaroon. Generate it with:
		lncli bakemacaroon --save_to lnproxy.macaroon \
			uri:/lnrpc.Lightning/DecodePayReq \
			uri:/lnrpc.Lightning/LookupInvoice \
			uri:/invoicesrpc.Invoices/AddHoldInvoice \
			uri:/invoicesrpc.Invoices/SubscribeSingleInvoice \
			uri:/invoicesrpc.Invoices/CancelInvoice \
			uri:/invoicesrpc.Invoices/SettleInvoice \
			uri:/routerrpc.Router/SendPaymentV2 \
			uri:/routerrpc.Router/EstimateRouteFee \
			uri:/chainrpc.ChainKit/GetBestBlock
`, os.Args[0])
		flag.PrintDefaults()
		os.Exit(2)
	}

	flag.Parse()
	var err error
	var macaroonBytes []byte
	if err := fees.applyEnvironment(os.Getenv); err != nil {
		log.Fatalln("invalid fee configuration:", err)
	}

	httpHost := os.Getenv("LNPROXY_HOST")
	if httpHost == "" {
		httpHost = *httpHostFlag
	}
	httpPort := os.Getenv("LNPROXY_PORT")
	if httpPort == "" {
		httpPort = *httpPortFlag
	}
	dbPath := os.Getenv("LNPROXY_DB")
	if dbPath == "" {
		dbPath = *dbPathFlag
	}
	retentionDays := *retentionFlag
	if v := os.Getenv("LNPROXY_EVENT_RETENTION_DAYS"); v != "" {
		retentionDays, err = strconv.ParseUint(v, 10, 64)
		if err != nil || retentionDays == 0 {
			log.Fatalln("LNPROXY_EVENT_RETENTION_DAYS must be a positive integer")
		}
	}
	// The admin token is read only from the environment so it stays out of `ps`.
	adminToken := os.Getenv("LNPROXY_ADMIN_TOKEN")
	if adminToken != "" {
		if err := relay.ValidateToken(adminToken); err != nil {
			log.Fatalln("LNPROXY_ADMIN_TOKEN:", err)
		}
	}

	lndHostString := os.Getenv("LNPROXY_LND_HOST")
	if lndHostString == "" {
		lndHostString = *lndHostStringFlag
	}
	verifyHostname := *verifyHostnameFlag
	if v := os.Getenv("LNPROXY_LND_TLS_VERIFY_HOSTNAME"); v != "" {
		verifyHostname, err = strconv.ParseBool(v)
		if err != nil {
			log.Fatalln("LNPROXY_LND_TLS_VERIFY_HOSTNAME must be true or false")
		}
	}
	lndCertPath := os.Getenv("LNPROXY_LND_CERT")
	if lndCertPath == "" {
		lndCertPath = *lndCertPathFlag
	}

	lnproxyMacaroon := os.Getenv("LNPROXY_MACAROON")
	if lnproxyMacaroon == "" && len(flag.Args()) == 1 {
		lnproxyMacaroon = flag.Args()[0]
	} else if lnproxyMacaroon == "" {
		flag.Usage()
		os.Exit(2)
	}

	macaroonBytes, err = os.ReadFile(lnproxyMacaroon)
	if err != nil {
		log.Fatalln("unable to read lnproxy macaroon file:", err)
	}
	macaroon := hex.EncodeToString(macaroonBytes)

	lndHost, err := url.Parse(lndHostString)
	if err != nil {
		log.Fatalln("unable to parse lnd host url:", err)
	}
	// If this is not set then websocket errors:
	lndHost.Path = "/"

	var lndTlsConfig *tls.Config
	if lndCertPath == "" {
		lndTlsConfig = &tls.Config{}
	} else {
		lndCert, err := os.ReadFile(lndCertPath)
		if err != nil {
			log.Fatalln("unable to read lnd tls certificate file:", err)
		}
		lndTlsConfig, err = lndTLSConfig(lndCert, verifyHostname)
		if err != nil {
			log.Fatalln("unable to use lnd tls certificate file:", err)
		}
	}

	lndClient := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: lndTlsConfig,
		},
	}

	lnd := &lnc.Lnd{
		Host:      lndHost,
		Client:    lndClient,
		TlsConfig: lndTlsConfig,
		Macaroon:  macaroon,
	}

	lnproxy_relay = relay.NewRelay(lnd)
	fees.apply(lnproxy_relay)
	lnproxy_relay.AdminToken = adminToken
	eventStore, err := relay.OpenEventStore(dbPath)
	if err != nil {
		log.Fatalln("unable to open event store:", err)
	}
	defer eventStore.Close()
	if err := lnproxy_relay.UseEventStore(eventStore); err != nil {
		log.Fatalln("unable to read event store:", err)
	}
	log.Printf("event store: %s (retention %d days, admin token %t)", dbPath, retentionDays, adminToken != "")
	go pruneEvents(eventStore, time.Duration(retentionDays)*24*time.Hour)
	feeAPI, err := newFeeSettingsAPI(lnproxy_relay, eventStore)
	if err != nil {
		log.Fatalln("unable to read saved fees:", err)
	}
	if fees, saved := feeAPI.current(); saved {
		logFees("fee configuration (saved from the status page)", fees, false)
	} else {
		logFees("fee configuration", fees, false)
	}

	network := os.Getenv("LNPROXY_NETWORK")
	if network == "" {
		network = *networkFlag
	}
	publicURL := os.Getenv("LNPROXY_PUBLIC_URL")
	if publicURL == "" {
		publicURL = *publicURLFlag
	}
	log.Printf("lnproxy-relay %s network=%q", version, network)
	page := newStatusPage(lnproxy_relay, network, publicURL)
	page.fees = feeAPI.current
	http.HandleFunc("/", statusHandler(page))
	http.Handle("/fees", feeAPI)
	http.Handle("/static/", staticHandler())
	http.HandleFunc("/spec", specApiHandler)
	http.HandleFunc("/events", eventsAPIHandler)
	serverContext, cancelServer := context.WithCancel(context.Background())
	defer cancelServer()

	server := &http.Server{
		Addr:              httpHost + ":" + httpPort,
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       20 * time.Second,
		WriteTimeout:      20 * time.Second,
		MaxHeaderBytes:    1 << 20,
		BaseContext:       func(net.Listener) context.Context { return serverContext },
	}

	idleConnsClosed := make(chan struct{})
	go func() {
		sigint := make(chan os.Signal, 1)
		signal.Notify(sigint, os.Interrupt, syscall.SIGTERM)
		<-sigint
		// SSE requests must finish before Shutdown can drain HTTP handlers.
		cancelServer()
		if err := server.Shutdown(context.Background()); err != nil {
			log.Println("HTTP server shutdown error:", err)
		}
		close(idleConnsClosed)
		log.Println("HTTP server shutdown")
	}()
	go func() {
		log.Println("HTTP server listening on:", server.Addr)
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			log.Println("HTTP server ListenAndServe error:", err)
		}
	}()
	<-idleConnsClosed

	signal.Reset(os.Interrupt, syscall.SIGTERM)
	log.Println("waiting for open circuits...")
	lnproxy_relay.WaitGroup.Wait()
}

func pruneEvents(store *relay.EventStore, retention time.Duration) {
	for {
		if n, err := store.Prune(time.Now().Add(-retention)); err != nil {
			log.Println("event store prune error:", err)
		} else if n > 0 {
			log.Println("pruned", n, "old invoice states")
		}
		time.Sleep(time.Hour)
	}
}
