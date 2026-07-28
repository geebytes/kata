# Kata update runtime refresh

`kata update` now refreshes managed platform files, then attempts Comet update, `codegraph sync`, and `codegraph index` in the selected project root. Each runtime step is reported independently in terminal and JSON output. Runtime refresh failures are non-fatal to completed managed-file updates and have a 750ms Comet update timeout.
