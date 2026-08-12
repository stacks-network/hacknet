---
name: hacknet
description: Operate stx-labs/hacknet as a reusable multi-node Stacks environment. Use when starting, resetting, observing, or debugging Hacknet; selecting a stacks-core revision; creating or restoring snapshots; changing topology; interacting with miner, signer, RPC, P2P, Bitcoin, API, stacking, or PoX services; reproducing reports; collecting runtime evidence; or troubleshooting a run.
---

# Hacknet

Use the checked-out repository as the source of truth. Do not duplicate its commands, defaults, ports, services, or environment variables when a repository document or configuration can be cited instead.

## Load the current interface

Resolve the repository root with `git rev-parse --show-toplevel`, then read only the files relevant to the task:

- Read [README.md](../../../README.md) for supported workflows, services, configuration, snapshots, and public test accounts.
- Read [Makefile](../../../Makefile) for the commands and argument parsing implemented by the checked-out revision.
- Read [docker/docker-compose.yml](../../../docker/docker-compose.yml) for effective services, profiles, builds, networks, ports, volumes, health checks, and environment defaults.
- Read [docker/stacks/Dockerfile](../../../docker/stacks/Dockerfile) before identifying the stacks-core revision, build mode, binaries, or features used by the containers.
- Read [docker/tests/hacknet-liveness.sh](../../../docker/tests/hacknet-liveness.sh) before treating its result as a baseline. Account for any state changes performed by the checks.
- Read [docker/tests/chain-monitor.sh](../../../docker/tests/chain-monitor.sh) and [docker/tests/restart-container.sh](../../../docker/tests/restart-container.sh) when monitoring or exercising lifecycle behavior.
- Read the Stacks TOML templates and relevant helpers under `docker/stacker/` when the task depends on node, signer, stacking, PoX, sBTC, or transaction-builder behavior.

Inspect these files again after changing the Hacknet revision. Prefer direct links to governing files and sections in outputs instead of restating them.

## Operate efficiently

1. Pin the inputs.

Record the full Hacknet and stacks-core commits, snapshot identity, effective Compose configuration, build mode, and topology. When working from a report, begin with its revision and evaluate newer revisions separately.

2. Reuse the nearest compatible snapshot.

Check available snapshots before building or starting from genesis. Restore the most advanced compatible stable state that precedes the work. Use genesis only when no compatible snapshot exists or when genesis behavior is itself relevant.

3. Preflight the current implementation.

Validate Docker and Compose availability, render the effective Compose configuration, and dry-run unfamiliar Make invocations. Inspect the current Makefile's parameter handling instead of assuming examples from another revision behave identically.

4. Gate readiness.

Use the repository liveness checks with a bounded retry loop. Verify the protocol state, services, and synchronization required for the task. Establish measurements only after any state-changing readiness checks finish.

5. Snapshot stable milestones.

Whenever the network reaches a healthy state that was expensive to produce and could be reused, create a named snapshot before continuing. Useful milestones include completed bootstrap, protocol activation, contract or service setup, signer registration, funded test state, and synchronized topology. Skip transient, inconsistent, or task-contaminated state.

6. Perform the requested work through the relevant service interface.

Use RPC, P2P, signer, Bitcoin, API, container lifecycle, monitoring, or helper interfaces as the task requires. Keep shared configuration explicit. Put task-specific helpers and Compose overrides in clearly identified files instead of hiding setup in mutable chainstate or undocumented local edits.

7. Create further checkpoints when the state becomes reusable again.

Long workflows may have several stable milestones. Snapshot each costly reusable checkpoint, record its parent and purpose, then continue from a fresh restoration when practical. This turns later retries and follow-up work into short runs instead of repeated bootstrap cycles.

8. Observe the relevant roles.

Collect identifiers that correlate requests, transactions, blocks, proposals, logs, and chain state. Query every participant required by the conclusion. Record timing, tip progress, service health, process exits, resource use, persistence, and recovery when relevant.

9. Collect results and tear down.

Save bounded logs, before/after state, effective configuration, commands, and structured observations before cleanup. Use the normal teardown implemented by the repository. Use forced teardown only after preserving useful state. Inspect destructive cleanup targets before running them.

## Snapshot discipline

Use the workflow documented in [README.md](../../../README.md) and implemented in [Makefile](../../../Makefile). Keep snapshot mechanics there so changes to the repository do not require duplicating them in this skill.

- Pin every input that affects compatibility.
- Snapshot only deterministic, healthy, synchronized states.
- Use distinct archive names for meaningful milestones. Do not replace a known-good snapshot until the replacement has passed a fresh restore and readiness check.
- Let the native snapshot target quiesce and archive state; do not copy live databases manually.
- Publish the snapshot hash and provenance: parent snapshot, Hacknet and stacks-core commits, effective configuration, protocol heights, topology, creation command, purpose, and validation observations.
- Regenerate or explicitly verify compatibility after chainstate schema, boot contract, activation, consensus-cost, PoX, service, or topology changes.
- Prefer a small set of useful milestone snapshots over many indistinguishable archives. Remove obsolete snapshots only after confirming that no workflow refers to them.

## Agent operation

- Treat snapshots as the primary time-saving mechanism. Before rebuilding, inspect whether a compatible stable checkpoint already exists or can be created from the current healthy state.
- Do not assume Docker works from inside another container. Determine whether the environment exposes Docker directly or through a trusted adapter, and report a missing execution capability clearly.
- Do not expose the host Docker socket to untrusted workloads. Keep repository, model, cloud, and publisher credentials outside disposable execution environments.
- Inspect the effective Compose configuration before attempting concurrent instances. Use separate Docker hosts unless container names, networks, ports, static addresses, and checkout-local state are demonstrably isolated.
- Use only Hacknet's documented public test keys, and never reuse them outside its regtest or testnet environment.

## Report results

Record the pinned runtime, restored or created snapshot, relevant interfaces, commands, observations, and remaining uncertainty. Distinguish environment or setup failures from conclusions about the behavior being investigated. Do not generalize a result beyond the roles and topology that were observed.
