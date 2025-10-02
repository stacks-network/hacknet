# List of binaries hacknet needs to function properly
COMMANDS := sudo tar zstd getent stress
$(foreach bin,$(COMMANDS),\
	$(if $(shell command -v $(bin) 2> /dev/null),$(info),$(error Missing required dependency: `$(bin)`)))
TARGET := $(firstword $(MAKECMDGOALS))
PARAMS := $(filter-out $(TARGET),$(MAKECMDGOALS))
# Hardcode the chainstate dir if we're booting from genesis
ifeq ($(TARGET),up-genesis)
	export CHAINSTATE_DIR := $(PWD)/docker/chainstate/genesis
endif
ifeq ($(TARGET),genesis)
	export CHAINSTATE_DIR := $(PWD)/docker/chainstate/genesis
endif

# UID and GID are not currently used, but may be later to ensure consistent file permissions
export UID := $(shell getent passwd $$(whoami) | cut -d":" -f 3)
export GID := $(shell getent passwd $$(whoami) | cut -d":" -f 4)
EPOCH := $(shell date +%s)
PWD = $(shell pwd)
# Set a unique project name (used for checking if the network is running)
PROJECT ?= hacknet
CHAINSTATE_ARCHIVE ?= $(PWD)/docker/chainstate.tar.zstd
export CHAINSTATE_DIR ?= $(PWD)/docker/chainstate/$(EPOCH)
export DOCKER_NETWORK ?= stacks
SERVICES := $(shell CHAINSTATE_DIR="" docker compose -f docker/docker-compose.yml --profile=default config --services)
# Pauses the bitcoin miner script. Default is set to nearly 1 trillion blocks
PAUSE_HEIGHT ?= 999999999999
# Used for the stress testing target. modifies how much cpu to consume for how long
STRESS_CORES ?= $(shell cat /proc/cpuinfo | grep processor | wc -l)
STRESS_TIMEOUT ?= 120

# Create the chainstate dir and extract an archive to it when the "up" target is used
$(CHAINSTATE_DIR): /usr/bin/tar /usr/bin/zstd
	@if  [ ! -d "$(CHAINSTATE_DIR)" ]; then \
		mkdir -p $(CHAINSTATE_DIR)
		@if [ "$(TARGET)" = "up" ]; then
			if [ -f "$(CHAINSTATE_ARCHIVE)" ]; then
				sudo tar --same-owner -xf $(CHAINSTATE_ARCHIVE) -C $(CHAINSTATE_DIR) || exit 1
			else
				@echo "Chainstate archive ($(CHAINSTATE_ARCHIVE)) not found. Exiting"
				rm -rf $(CHAINSTATE_DIR)
				exit 1
			fi
		fi
	fi

# Build the images with a cache if present
build: check-not-running
	COMPOSE_BAKE=true PWD=$(PWD) docker compose -f docker/docker-compose.yml --profile default -p $(PROJECT) build

# Build the images without a cache (default uses cache)
build-no-cache: check-not-running
	COMPOSE_BAKE=true PWD=$(PWD) docker compose -f docker/docker-compose.yml --profile default -p $(PROJECT) build --no-cache

# Set env var of what the statically defined chainstate dir is
current-chainstate-dir: | check-running
	$(eval ACTIVE_CHAINSTATE_DIR=$(shell cat .current-chainstate-dir))

# If the network is already running, we need to exit (ex: trying to start the network when it's already running)
check-not-running:
	@if test `docker compose ls --filter name=$(PROJECT) -q`; then \
		echo ""; \
		echo "WARNING: Network appears to be running or was not properly shut down."; \
		echo "Current chainstate directory: $$(cat .current-chainstate-dir)"; \
		echo ""; \
		echo "To shut down:         make down"; \
		echo ""; \
		exit 1; \
	fi

# If the network is not running, we need to exit (ex: trying to restart a container)
check-running:
	@if test ! `docker compose ls --filter name=$(PROJECT) -q`; then \
		echo "Network not running. exiting"; \
		exit 1; \
	fi

# For targets that need an arg, check that *something* is provided. it not, exit
check-params: | check-running
	@if [ ! "$(PARAMS)" ]; then \
		echo "No service defined. Exiting"; \
		exit 1; \
	fi

# Boot the network from a local chainstate archive
up: check-not-running | build $(CHAINSTATE_DIR)
	@echo "Starting $(PROJECT) network from chainstate archive"
	@echo "  Chainstate Dir: $(CHAINSTATE_DIR)"
	@echo "  Chainstate Archive: $(CHAINSTATE_ARCHIVE)"
	echo "$(CHAINSTATE_DIR)" > .current-chainstate-dir
	docker compose -f docker/docker-compose.yml --profile default -p $(PROJECT) up -d

# Boot the network from genesis
genesis: check-not-running | build $(CHAINSTATE_DIR) /usr/bin/sudo
	@echo "Starting $(PROJECT) network from genesis"
	@if  [ -d "$(CHAINSTATE_DIR)" ]; then \
		echo "    Removing existing genesis chainstate dir: $(CHAINSTATE_DIR)"; \
		sudo rm -rf $(CHAINSTATE_DIR); \
	fi
	@echo "  Chainstate Dir: $(CHAINSTATE_DIR)"
	mkdir -p "$(CHAINSTATE_DIR)"
	echo "$(CHAINSTATE_DIR)" > .current-chainstate-dir
	docker compose -f docker/docker-compose.yml --profile default -p $(PROJECT) up -d

# Secondary name to boot the genesis network
up-genesis: genesis

up-prom:
	@echo "Starting $(PROJECT) prometheus monitoring"
	docker compose -f docker/docker-compose.prom.yml --profile default -p $(PROJECT) up -d

down-prom:
	@echo "Shutting down $(PROJECT) prometheus monitoring"
	docker compose -f docker/docker-compose.prom.yml --profile default -p $(PROJECT) down

# Shut down the network (chainstate and logs will be preserved)
down: backup-logs current-chainstate-dir
	@echo "Shutting down $(PROJECT) network"
	docker compose -f docker/docker-compose.yml --profile default -p $(PROJECT) down
	@if [ -f .current-chainstate-dir ]; then \
		rm -f .current-chainstate-dir
	fi

# Secondary name to bring down the genesis network
down-genesis: down

# If the network is in an unexpected state - this target will force kill (bypassing error checks)
down-force:
	@echo "Force Shutting down $(PROJECT) network"
	docker compose -f docker/docker-compose.yml --profile default -p $(PROJECT) down
	@if [ -f .current-chainstate-dir ]; then \
		rm -f .current-chainstate-dir
	fi

# Stream specified service logs to STDOUT. Does not validate if PARAMS is supplied
log: current-chainstate-dir
	@echo "Logs for service $(PARAMS)"
	docker compose -f docker/docker-compose.yml --profile default -p $(PROJECT) logs -t --no-log-prefix $(PARAMS) -f

# Stream all services logs to STDOUT
log-all: current-chainstate-dir
	docker compose -f docker/docker-compose.yml --profile default -p $(PROJECT) logs -t -f

# Backup all service logs to $ACTIVE_CHAINSTATE_DIR/logs/<service-name>.log
backup-logs: current-chainstate-dir /usr/bin/sudo
	@if [ -f .current-chainstate-dir ]; then \
		$(eval ACTIVE_CHAINSTATE_DIR=$(shell cat .current-chainstate-dir))
		if  [ ! -d "$(ACTIVE_CHAINSTATE_DIR)" ]; then \
			echo "Chainstate Dir ($(ACTIVE_CHAINSTATE_DIR)) not found";\
			exit 1; \
		fi; \
		if  [ ! -d "$(ACTIVE_CHAINSTATE_DIR)/logs" ]; then \
			mkdir -p $(ACTIVE_CHAINSTATE_DIR)/logs;\
		fi; \
		echo "Backing up logs to $(ACTIVE_CHAINSTATE_DIR)/logs"; \
		for service in $(SERVICES); do \
			docker logs -t $$service > $(ACTIVE_CHAINSTATE_DIR)/logs/$$service.log 2>&1; \
		done; \
	fi

# Replace the existing chainstate archive. Will be used with target `up`
snapshot: current-chainstate-dir down
	@echo "Creating $(PROJECT) chainstate snapshot from $(ACTIVE_CHAINSTATE_DIR)"
	@if  [ -d "$(ACTIVE_CHAINSTATE_DIR)/logs" ]; then \
		rm -rf $(ACTIVE_CHAINSTATE_DIR)/logs; \
	fi
	@echo "Creating snapshot: $(CHAINSTATE_ARCHIVE)"
	@echo "cd $(ACTIVE_CHAINSTATE_DIR); sudo tar --zstd -cf $(CHAINSTATE_ARCHIVE) *; cd $(PWD)"
	cd $(ACTIVE_CHAINSTATE_DIR); sudo tar --zstd -cf $(CHAINSTATE_ARCHIVE) *; cd $(PWD)

# Pause all services in the network (netork is down, but recoverably with target 'unpause')
pause:
	@echo "Pausing all services"
	docker compose -f docker/docker-compose.yml --profile default -p $(PROJECT) pause $(SERVICES)

# Unpause all services in the network (only used after first using target 'pause')
unpause:
	@echo "Unpausing all services"
	docker compose -f docker/docker-compose.yml --profile default -p $(PROJECT) unpause $(SERVICES)

# Stop an individual service
stop: check-params current-chainstate-dir | check-running
	@echo "Killing service $(PARAMS)"
	@echo "  Chainstate Dir: $(ACTIVE_CHAINSTATE_DIR)"
	@echo "  Target: $(TARGET)"
	@echo "  Params: $(PARAMS)"
	CHAINSTATE_DIR=$(ACTIVE_CHAINSTATE_DIR) docker compose -f docker/docker-compose.yml --profile default -p $(PROJECT) down $(PARAMS)

# Start an individual service
start: check-params current-chainstate-dir | check-running
	@echo "Resuming service $(PARAMS)"
	@echo "  Chainstate Dir: $(ACTIVE_CHAINSTATE_DIR)"
	@echo "  Target: $(TARGET)"
	@echo "  Params: $(PARAMS)"
	CHAINSTATE_DIR=$(ACTIVE_CHAINSTATE_DIR) docker compose -f docker/docker-compose.yml --profile default -p $(PROJECT) up -d $(PARAMS)

# Restart a service with a defined servicename/duration - the script will validate PARAMS
#   If no duration is provided, a default of 30s shall be used
restart: check-params | check-running
	@echo "Restarting service"
	@echo "  Params: $(PARAMS)"
	./docker/tests/restart-container.sh $(PARAMS)

# Use 'stress' binary to consume defined cpu over a specified time
stress:
	@echo "Stressing system CPU $(PARAMS)"
	@echo "  Cores: $(STRESS_CORES)"
	@echo "  Timeout: $(STRESS_TIMEOUT)"
	stress --cpu $(STRESS_CORES) --timeout $(STRESS_TIMEOUT)

# Run the liveness script to verify the services are all loaded and operating as expected
test:
	./docker/tests/hacknet-liveness.sh

# Run the chain monitor script (loops and curls /v2/info, parsing the output to show current heights of miners)
monitor:
	./docker/tests/chain-monitor.sh

# Force stop and remove any existing chainstates (leaving all docker images/layers)
clean: down-force
	sudo rm -rf ./docker/chainstate/*

.PHONY: build build-no-cache current-chainstate-dir check-not-running check-running check-params up genesis up-genesis down down-genesis down-force log log-all backup-logs snapshot pause unpause stop start restart stress test monitor clean
.ONESHELL: all-in-one-shell
