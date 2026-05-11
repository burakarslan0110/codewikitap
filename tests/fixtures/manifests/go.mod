module example.com/fixture-app

go 1.22

require (
	github.com/spf13/cobra v1.9.0
	github.com/stretchr/testify v1.10.0
	golang.org/x/sync v0.10.0
)

require github.com/google/uuid v1.6.0

require (
	github.com/davecgh/go-spew v1.1.2 // indirect
	github.com/pmezard/go-difflib v1.0.1-0.20181226105442-5d4384ee4fb2 // indirect
)

retract v0.0.1

replace github.com/old/pkg => github.com/new/pkg v1.2.3
