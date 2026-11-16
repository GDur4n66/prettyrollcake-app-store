package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
)

// lndTLSConfig trusts only the certificates in certPEM. With verifyHostname
// false the chain is still verified against that pinned certificate, but the
// host name is not compared. This is for LND certificates that do not list
// the address the relay connects to (for example a container IP on Umbrel).
func lndTLSConfig(certPEM []byte, verifyHostname bool) (*tls.Config, error) {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(certPEM) {
		return nil, errors.New("no certificate found in lnd tls cert file")
	}
	if verifyHostname {
		return &tls.Config{RootCAs: pool}, nil
	}
	return &tls.Config{
		// Hostname verification is replaced by VerifyPeerCertificate below.
		InsecureSkipVerify: true,
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return errors.New("lnd presented no certificate")
			}
			certs := make([]*x509.Certificate, len(rawCerts))
			for i, raw := range rawCerts {
				cert, err := x509.ParseCertificate(raw)
				if err != nil {
					return err
				}
				certs[i] = cert
			}
			intermediates := x509.NewCertPool()
			for _, cert := range certs[1:] {
				intermediates.AddCert(cert)
			}
			_, err := certs[0].Verify(x509.VerifyOptions{Roots: pool, Intermediates: intermediates})
			return err
		},
	}, nil
}
