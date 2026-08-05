# Build for the AIM desktop wrapper.
#
# fyne.io/systray uses native APIs on macOS (Cocoa) and Linux (GTK/dbus), so CGO
# is required there — you cannot cross-compile a Mac or Linux binary from Windows
# without an OSXCross/MinGW toolchain. Each platform builds on its own host; CI
# uses a matrix to do exactly that.
#
#   make build        auto-detect the host and build for it
#   make build-win    dist/AIM.exe            (Windows host)
#   make build-mac    dist/AIM-darwin-*       (macOS host)
#   make build-linux  dist/aim-tray           (Linux host)
#   make run          foreground, dev mode
#   make clean

VERSION := $(shell node -p "require('../package.json').version" 2>/dev/null || echo "0.0.0")

# -H windowsgui is what makes this an application rather than a console program:
# without it, every launch shows a black console window behind the app.
LDFLAGS_WIN   := -ldflags="-H windowsgui -s -w -X main.AIMVersion=$(VERSION)"
LDFLAGS_POSIX := -ldflags="-s -w -X main.AIMVersion=$(VERSION)"

DIST := dist
UNAME_S := $(shell uname -s 2>/dev/null || echo Windows)

.PHONY: build build-win build-mac build-linux clean run tidy print-version

build: $(DIST)
ifeq ($(OS),Windows_NT)
	@$(MAKE) build-win
else ifeq ($(UNAME_S),Darwin)
	@$(MAKE) build-mac
else
	@$(MAKE) build-linux
endif

build-win: $(DIST)
	@echo "-> Windows amd64 (v$(VERSION))"
	go run github.com/tc-hib/go-winres@v0.3.3 make --in winres/winres.json
	go build $(LDFLAGS_WIN) -o $(DIST)/AIM.exe .

build-mac: $(DIST)
	@echo "-> macOS arm64 + amd64 (v$(VERSION)), CGO enabled"
	CGO_ENABLED=1 GOARCH=arm64 go build $(LDFLAGS_POSIX) -o $(DIST)/AIM-darwin-arm64 .
	CGO_ENABLED=1 GOARCH=amd64 go build $(LDFLAGS_POSIX) -o $(DIST)/AIM-darwin-amd64 .

build-linux: $(DIST)
	@echo "-> Linux amd64 (v$(VERSION)), CGO enabled"
	@echo "   needs: apt install gcc libgtk-3-dev libayatana-appindicator3-dev"
	CGO_ENABLED=1 go build $(LDFLAGS_POSIX) -o $(DIST)/aim-tray .

$(DIST):
	@mkdir -p $(DIST) 2>/dev/null || true

clean:
	rm -rf $(DIST) rsrc_windows_*.syso

run:
	go run .

tidy:
	go mod tidy

print-version:
	@echo "$(VERSION)"
