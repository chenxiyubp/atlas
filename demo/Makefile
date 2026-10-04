# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later

SHELL := /usr/bin/env bash

MINUTES ?= 10
CHUNKS ?= 20
ITERATIONS ?= 3
SEED ?= 6101

.PHONY: p61-reset p61-smoke p61 p61-accept

p61-reset:
	@cd .. && bun run demo/lib/p61-seed.ts --reset --seed "$(SEED)"

p61-smoke: p61-reset
	@./p61-e2e.sh --mode smoke --minutes 1 --chunks 4 --iterations "$(ITERATIONS)"

p61: p61-reset
	@./p61-e2e.sh --mode acceptance --minutes "$(MINUTES)" --chunks "$(CHUNKS)" --iterations "$(ITERATIONS)"

p61-accept:
	@for run in 1 2 3; do \
		printf 'P6.1 acceptance run %s/3\n' "$$run"; \
		$(MAKE) --no-print-directory p61 || exit $$?; \
	done
