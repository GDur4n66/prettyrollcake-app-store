package relay

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// EventStore persists the current state of every invoice and a history of
// state transitions so that subscribers can resume after a relay restart.
// Invoices are linked to the SHA-256 of the client's token, never the token.
type EventStore struct {
	db *sql.DB
}

const storeSchema = `
CREATE TABLE IF NOT EXISTS invoices (
	payment_hash  TEXT PRIMARY KEY,
	owner         TEXT NOT NULL,
	state         TEXT NOT NULL,
	original_paid INTEGER NOT NULL,
	seq           INTEGER NOT NULL,
	updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invoices_owner_seq ON invoices (owner, seq);
CREATE TABLE IF NOT EXISTS events (
	seq           INTEGER PRIMARY KEY,
	payment_hash  TEXT NOT NULL,
	owner         TEXT NOT NULL,
	state         TEXT NOT NULL,
	original_paid INTEGER NOT NULL,
	created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_owner_seq ON events (owner, seq);
`

// OpenEventStore opens (or creates) the SQLite database at path.
// An empty path keeps everything in memory for the life of the process.
func OpenEventStore(path string) (*EventStore, error) {
	dsn := "file::memory:"
	if path != "" {
		dsn = "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection keeps ":memory:" a single database and serialises writes.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(storeSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialising event store: %w", err)
	}
	return &EventStore{db: db}, nil
}

func (s *EventStore) Close() error { return s.db.Close() }

func (s *EventStore) maxSeq() (uint64, error) {
	var seq sql.NullInt64
	err := s.db.QueryRow(`SELECT MAX(seq) FROM (SELECT seq FROM events UNION ALL SELECT seq FROM invoices)`).Scan(&seq)
	return uint64(seq.Int64), err
}

func (s *EventStore) minEventSeq() (uint64, bool, error) {
	var seq sql.NullInt64
	err := s.db.QueryRow(`SELECT MIN(seq) FROM events`).Scan(&seq)
	return uint64(seq.Int64), seq.Valid, err
}

func (s *EventStore) originalPaid(hash string) (bool, error) {
	var paid bool
	err := s.db.QueryRow(`SELECT original_paid FROM invoices WHERE payment_hash = ?`, hash).Scan(&paid)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return paid, err
}

func (s *EventStore) record(event InvoiceEvent, now time.Time) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO events (seq, payment_hash, owner, state, original_paid, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		event.sequence, event.PaymentHash, event.owner, event.State, event.OriginalInvoicePaid, now.Unix()); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO invoices (payment_hash, owner, state, original_paid, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (payment_hash) DO UPDATE SET owner = excluded.owner, state = excluded.state,
			original_paid = excluded.original_paid, seq = excluded.seq, updated_at = excluded.updated_at`,
		event.PaymentHash, event.owner, event.State, event.OriginalInvoicePaid, event.sequence, now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

func scanEvents(rows *sql.Rows) ([]InvoiceEvent, error) {
	defer rows.Close()
	events := make([]InvoiceEvent, 0)
	for rows.Next() {
		var event InvoiceEvent
		if err := rows.Scan(&event.sequence, &event.PaymentHash, &event.owner, &event.State, &event.OriginalInvoicePaid); err != nil {
			return nil, err
		}
		event.ID = formatEventID(event.sequence)
		events = append(events, event)
	}
	return events, rows.Err()
}

// current returns the latest state of each invoice visible to the subscriber.
func (s *EventStore) current(sub subscription) ([]InvoiceEvent, error) {
	rows, err := s.db.Query(`SELECT seq, payment_hash, owner, state, original_paid FROM invoices
		WHERE ? OR owner = ? ORDER BY seq`, sub.all, sub.owner)
	if err != nil {
		return nil, err
	}
	return scanEvents(rows)
}

// since returns the transitions after cursor visible to the subscriber.
func (s *EventStore) since(cursor uint64, sub subscription) ([]InvoiceEvent, error) {
	rows, err := s.db.Query(`SELECT seq, payment_hash, owner, state, original_paid FROM events
		WHERE seq > ? AND (? OR owner = ?) ORDER BY seq`, cursor, sub.all, sub.owner)
	if err != nil {
		return nil, err
	}
	return scanEvents(rows)
}

// Prune deletes history and invoices last updated before cutoff.
func (s *EventStore) Prune(cutoff time.Time) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM events WHERE created_at < ?`, cutoff.Unix()); err != nil {
		return 0, err
	}
	result, err := tx.Exec(`DELETE FROM invoices WHERE updated_at < ?`, cutoff.Unix())
	if err != nil {
		return 0, err
	}
	n, _ := result.RowsAffected()
	return n, tx.Commit()
}
