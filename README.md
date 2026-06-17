# Hacknet

- Configured for 3 stacks miners and signers
- bind-mounts a local filesystem for data persistence
- Uses a chainstate archive to boot the network quickly
- Configurable signing weight across the 3 signers
- Configured for Epoch 4.0 / PoX-5 using the PoX waterfall integration branch
- Designed to run on Linux (tested on Debian-based) or MacOS

## Quickstart

### Start network using a chainstate archive

_Note_: default chainstate archive at `./docker/chainstate.tar.zstd` will be used unless overridden by `CHAINSTATE_ARCHIVE` env var.

Creates a dynamic chainstate folder at `./docker/chainstate/$(date +%s)` from a chainstate archive

```sh
make up
```

To override the archive used to restore the network:

```sh
CHAINSTATE_ARCHIVE=./docker/chainsate_new.tar.zstd make up
```

To override the chainstate dir and resume a stopped network:
_Note_: will not work for the `genesis` chainstate dir and absolute path is required

```sh
CHAINSTATE_DIR=$(pwd)/docker/chainsate/<existing chainstate dir> make up
```

### Start network from genesis

Creates a static chainstate folder at `./docker/chainstate/genesis`

```sh
make genesis
```

### Stop the network

```sh
make down
```

## Full list of options

### Epoch 4.0 / PoX-5

Hacknet defaults to the Stacks Core PoX-5 integration SHA configured in `docker/docker-compose.yml`.
The main PoX-5 controls are:

- `STACKS_CORE_BASE_BRANCH`: branch, tag, or commit SHA used to build `stacks-node` and `stacks-signer`
- `STACKS_40_HEIGHT`: Epoch 4.0 activation height, default `262`
- `POX_5_DEPLOYER_PRIVATE_KEY`: funded key that deploys PoX-5 prerequisite sBTC contracts
- `POX_5_SBTC_CONTRACT`: contract id used by `.pox-5` for the sBTC token
- `POX_5_SBTC_REGISTRY_CONTRACT`: contract id used by signer-set computation for the sBTC aggregate key
- `POX_5_BOND_ADMIN`: principal initialized as PoX-5 bond admin
- `POX_5_BOND_ADMIN_PRIVATE_KEY`: key used by the opt-in Bitcoin Staking helper to call `setup-bond`

Changing these values requires a fresh genesis run and a regenerated chainstate archive.

### Bitcoin Staking

Bitcoin Staking is available as an opt-in compose profile:

```sh
docker compose -f docker/docker-compose.yml --profile default --profile bitcoin-staking up bitcoin-staking
```

The helper waits for `.pox-5`, waits for signer-manager registration, sets up an available protocol bond, mints mock sBTC to the configured participants, and registers those participants through `register-for-bond` using the sBTC path.

- `BITCOIN_STAKING_KEYS`: funded participant keys, defaulting to accounts that are not used by `tx-broadcaster`
- `BITCOIN_STAKING_BOND_INDEX`: first bond index to try, default `0`
- `BITCOIN_STAKING_AMOUNT_USTX`: STX to lock per participant, default `99000000000000`
- `BITCOIN_STAKING_AMOUNT_SATS`: sBTC sats to bond per participant, default `1000000`
- `BITCOIN_STAKING_TARGET_RATE`, `BITCOIN_STAKING_STX_VALUE_RATIO`, `BITCOIN_STAKING_MIN_USTX_RATIO`: PoX-5 bond parameters

### Logs

`docker logs -f <service>` will work, along with some defined Makefile targets

#### Store logs from all services under the current chainstate folder

```sh
make backup-logs
```

#### Stream logs from all services

```sh
make log-all
```

#### Stream single service logs

```sh
make log stacks-signer-1 -- -f
```

#### Log from a single service

_note_ this will not follow the logs

```sh
make log stacks-signer-1
```

### Container management

#### Pause/Unpause service

To pause all services on the network

```sh
make pause
```

To resume the network

```sh
make unpause
```

#### Restart a service

Used to simulate a node dropping off of the network

```sh
make restart <container name> <number of seconds before restarting>
```

ex:

```sh
make restart stacks-miner-3 61
```

#### Stop/Start service (kill)

Stop a single service

```sh
make stop <service name>
```

Restart the stopped service

```sh
make start <service name>
```

#### Force stop the hacknet network

If the network is in a "stuck" state where the Makefile targets are not stopping the services (i.e. the `.current-chainstate-dir` file was removed while network was running), `down-force` may be used to force stop the network.

```sh
make down-force
```

Additionally, `clean` target will call `down-force` _and also_ delete any chainstates on disk in `./docker/chainstate/*`

```sh
make clean
```

### Additional Features

#### Stress the CPU

To simulate CPU load. Can be modified with:

- `STRESS_CORES` to target how many worker threads (default will use all cores)
- `STRESS_TIMEOUT` set a timeout (default of 120s)

```sh
make stress
```

```sh
STRESS_CORES=10 STRESS_TIMEOUT=60 make stress
```

#### Monitor chain heights

Run a script outputting the current chain heights of each miner

```sh
make monitor
```

#### Create a chainstate snapshot

- Setting the env var `PAUSE_HEIGHT` is optional to pause the chain at a specific height, else a default of Bitcoin block `999999999999` is used.
- Setting the env var `MINE_INTERVAL_EPOCH3` is recommended to reach the `PAUSE_HEIGHT` more quickly to create the snapshot
- Optionally, the `CHAINSTATE_ARCHIVE` env var may be set to store the archive in a non-default location/name
  **This operation will work with either the `up` or `genesis` targets**

```sh
make genesis
```

or with env vars set:

```sh
MINE_INTERVAL_EPOCH3=10 PAUSE_HEIGHT=240 make genesis
```

Followed by waiting until the Bitcoin miner reaches the specified height (ex: `docker logs -f bitcoin-miner`)
Once the Bitcoin miner has reached the specified height:

```sh
make snapshot
```

This will first bring down the network, then replace the existing `./docker/chainstate.tar.zstd` archive file used with the `up` Makefile target.

To create the chainstate archive in a non-default location/name _File path must be absolute_:

```sh
CHAINSTATE_ARCHIVE=$(pwd)/docker/chainstate_new.tar.zstd make snapshot
```

**Note**: `CHAINSTATE_ARCHIVE` must be defined to use with `make up` to use a non-default snapshot.
ex:

```sh
CHAINSTATE_ARCHIVE=./docker/chainstate_new.tar.zstd make up
```

#### Prometheus sidecar

##### Run prometheus and cadvisor

Runs a prometheus container to record data collected by `cadvisor` for tracking host/container metrics

```sh
make up-prom
```

##### Stop prometheus and cadvisor

```sh
make down-prom
```

## Containers

- **bitcoin**: Runs a bitcoin regtest node
- **bitcoin-miner**: creates 3 bitcoin regtest wallets and mines regtest blocks at a configurable cadence. After initial setup (~200 blocks), creates a dedicated "block-producer" wallet for ongoing Bitcoin block production to prevent conflicts with Stacks mining operations
- **stacks-miner-1**: mines stacks blocks and sends events to stacks-signer-1
- **stacks-miner-2**: mines stacks blocks and sends events to stacks-signer-2
- **stacks-miner-3**: mines stacks blocks and sends events to stacks-signer-3
- **stacks-signer-1**: event observer for stacks-miner-1
- **stacks-signer-2**: event observer for stacks-miner-2
- **stacks-signer-3**: event observer for stacks-miner-3
- **stacks-api**: API instance receiving events from stacks-miner-1
- **postgres**: postgres DB used by stacks-api
- **pox5-setup**: deploys `sbtc-registry` and `sbtc-token` before Epoch 4.0 so `.pox-5` can initialize
- **stacker**: stack for `stacks-signer-1`, `stacks-signer-2` and `stacks-signer-3`
- **bitcoin-staking**: optional helper that configures a PoX-5 protocol bond and registers funded participants with mock sBTC
- **tx-broadcaster**: submits token transfer txs to ensure stacks block production during a sortition

## Bitcoin Miner

_Dedicated address for Bitcoin block production after initial setup (~200 blocks). This prevents conflicts with Stacks mining operations._

```text
‣ Mnemonic:               foot script pledge suit bread thing stage long auction craft label injury helmet drum ice govern glass tag lamp shield bike raccoon cloud hat
‣ Private Key:            372aace2f66b6af7b195cffd5168133917fa87504acc422db4e8c273ce10d56f01
‣ Public Key:             03d9ea1e7b47857ffc7611adc93eb2819d5996d3f63bcfd01508b51a4861671db1
‣ BTC Address:            mqiURdmHMv61yJYjxKyMUjk7dfQRV9ffFF
‣ WIF:                    cPRwPMm4JdEmJpCzFiwGP5ntdKj3pYN6ZWLQNRMAuH3HHei4Ph9N
```

## Stacks Miner Accounts

### Miner 1

```text
‣ Mnemonic:               dream toast small waste nature name common infant forget win box mountain climb genuine pole vote usage move frown onion raise lend cluster domain
‣ Private Key:            e63a284b28a3144036dc7f789c4eaa0edd637a94f8be9124f12157f2f740186301
‣ Public Key:             02377723916737a6436171dd7bb6e1b01d30958d29c1818f169c53448b45610bb1
‣ BTC Address:            ms7WBhM8uXkvfxEQvVVTpr4AuL3KpnqPsv
‣ Stacks Address:         ST1ZK49D6T6XDDMDVR7V3T5SYF0ET9N7DMCJV9ZKV
‣ WIF:                    cVJEUhWLAVG9vx7RcnF6djdnXqkTG4qkPvjbgpbQBePF8FQyUpHb
‣ Miner Rewards
  ‣ Stacks address:         ST1XVSVQN0KP5SDYFNT8E5TXWVW0XZVQEDBMCJ3XM
  ‣ Private Key:            a6143d20cd73d0dce2179e2af7771372a95b9d6795924492bd4d15d17709531e01
  ‣ Mnemonic:               federal reform visual spot pioneer side knife crouch hazard happy home stem gentle squeeze brother scorpion fuel accident blade tonight world arch raw poet
  ‣ WIF:                    cT9Y8q23uyUkfzPwLvfQQDmHacBdyZKhSKBWTCQ9QZz2tkaL6g4e
```

### Miner 2

```text
‣ Mnemonic:               olive you plate doctor robot venture sniff aisle coffee roast resist leader language exist wreck alcohol feature best series social click company entire peanut
‣ Private Key:            9803278e4c1db9e6d26c902549f52b3fe3c88fe9a5293c774721a9bc5bc9dfb301
‣ Public Key:             0371b15f50be3a3498a2c26ce4d616c506ed0d8e6ce050c4ac7b0ffa40ca081829
‣ BTC Address:            msgxV5Z9poN2SKent3RhURjiEqJy7WUCnD
‣ Stacks Address:         ST22RBMZ4CMXYAVBED3KTMZEWRMA0ST6XSGBSX10H
‣ WIF:                    cSgCBxt7hidTVjsCLm8wGBxKWa4JDjYPmHUsX41xbMc5cdkBMUvY
‣ Miner Rewards
  ‣ Stacks address:         ST2FW15NGB4H76FMVXKHYYSM865YVS6V3SA1GNABC
  ‣ Private Key:            fe3087801196d8027008146b13e6d365920c2e4b7bc9969729ec2f0f22ef74fc01
  ‣ WIF:                    cW6p6zjVTXFXKQu3JmwfvRtkM5nAqCe1nakyhbd1VrZU59FJLew1

```

### Miner 3

```text
‣ Mnemonic:               rude fabric harsh mechanic until cricket field flag draw enough bitter flower people opera tackle horse unusual mass property height olympic artist demise major
‣ Private Key:            19ff71655f1f5992f865fac2c840587ed328da32042a1c20e8b8be199a0b7b4101
‣ Public Key:             03d13351e8f7b356b32289812479f7376dcd620cd76acad02352e41fe4edce500a
‣ BTC Address:            mgKsVRnASphbAiSp81Ct9sJ4bgNkhtayij
‣ Stacks Address:         ST4DZ2J4VWYBEQC0319V7CN8JDYE2WMESPSWMGDE
‣ WIF:                    cNTEkvsFoTZnd3eJMH477uELJnktYZeCDWwy5PHgWYg6XvxHKNo5
‣ Miner Rewards
  ‣ Stacks address:         ST2MES40ZEXTX9M4YXW9QSWHRVC9HYT419S198VPM
  ‣ Private Key:            ed7eb063c61b8e892987228f1fcfb74eab5009568861613dc4b074b708a7893701
  ‣ WIF:                    cVYMsUwHAZCdwfXZ2rgXWrFJDfqW2TrvLBAVpWCLCteCTTbv7UXL


```

## Signer Accounts

### Signer 1

```text
‣ Mnemonic:     number pause unfold flash cover thank spray road moment scatter wreck scrap cricket enemy enlist chest all dog force magnet giggle canyon spatial such
‣ Private Key:  41634762d89dfa09133a4a8e9c1378d0161d29cd0a9433b51f1e3d32947a73dc01
‣ Public Key:   035249137286c077ccee65ecc43e724b9b9e5a588e3d7f51e3b62f9624c2a49e46
‣ STX Address:  ST24VB7FBXCBV6P0SRDSPSW0Y2J9XHDXNHW9Q8S7H
‣ BTC Address:  mt56SJB4aQRz8xA13gnkNnqxZc2dESq6Sq
‣ WIF:          cPmokz1FLbW5KyZGMeSoDBeoRB51358dPzRJatiazpjLUnfaDe55
```

### Signer 2

```text
‣ Mnemonic:     puppy ladder save liar close fix deliver later victory ugly rural artwork topic camera orphan depart power pottery retreat walk ignore army employ turkey
‣ Private Key:  9bfecf16c9c12792589dd2b843f850d5b89b81a04f8ab91c083bdf6709fbefee01
‣ Public Key:   031a4d9f4903da97498945a4e01a5023a1d53bc96ad670bfe03adf8a06c52e6380
‣ STX Address:  ST2XAK68AR2TKBQBFNYSK9KN2AY9CVA91A7CSK63Z
‣ BTC Address:  mxXw9bceXuFB6HZjqriS527kTqt5H9VczT
‣ WIF:          cSowFfhhyLhwsxCQHYzFGLKZYGjob3oQ6ZwH1v4WAAcxeb4Wn4ro
```

### Signer 3

```text
‣ Mnemonic:     want stove parent truly label duck small aspect pumpkin image purity stove pottery check voyage person weasel category cat inspire portion sun lab piece
‣ Private Key:  3ec0ca5770a356d6cd1a9bfcbf6cd151eb1bd85c388cc00648ec4ef5853fdb7401
‣ Public Key:   02007311430123d4cad97f4f7e86e023b28143130a18099ecf094d36fef0f6135c
‣ STX Address:  ST1J9R0VMA5GQTW65QVHW1KVSKD7MCGT27X37A551
‣ BTC Address:  mpgvmF9DSDBrbxUY4rbsPmWkYakoDXr19j
‣ WIF:          cPggi5foghgcKAGnbRwCLMDpQCCmWVUZ9r7PkWQ7cCfK69BWLXdk
```

## Transaction-Generation Accounts

### Account 1

```text
‣ Mnemonic:     sorry door captain volume century wood soap asset scheme idea alley mammal effort shoulder gravity car pistol reform aisle gadget gown future lawsuit tone
‣ Private Key:  e26e611fc92fe535c5e2e58a6a446375bb5e3b471440af21bbe327384befb50a01
‣ Public Key:   03fb84a4a2931e7d0ec36bf6e695233bec878fd545bad580751cf4a49d78a7bb27
‣ STX Address:  ST1YEHRRYJ4GF9CYBFFN0ZVCXX1APSBEEQ5KEDN7M
‣ BTC Address:  mruR58H7NvUgmDydv1BM8zMT8og6QxN1Rx
‣ WIF:          cVArVw9FJPeygtZhRtHJEhDqEQTeC3Ybw3UjXt1ir6RgMkMj1Mcz
```

### Account 2

```text
‣ Mnemonic:     album bid grant because narrow unusual unknown machine quick core dolphin occur repair decade toilet betray word people mule assume gesture faint trend about
‣ Private Key:  e3ebd73a51da9a2ab0c6679145420876bf4338554a8972e3ab200cef7adbec6001
‣ Public Key:   03e5049566e351debe8c4d9918faafac751fdcc0e80d3db59069b45761b39015f5
‣ STX Address:  ST1WNJTS9JM1JYGK758B10DBAMBZ0K23ADP392SBV
‣ BTC Address:  mrabBBLKnSZq8fziECh4TsNwVbmdGv6JDV
‣ WIF:          cVDkVrPTBEVa9fFGwFQT4zKi9dXFUJqLym3Ct6MJTepT6Wh5413g
```

### Account 3

```text
‣ Mnemonic:     action still web blush proud cat axis barrel tower assault cram catch more soup auction require again valley letter calm license release fruit industry
‣ Private Key:  0bfff38daea4561a4343c9b3f29bfb06e32a988868fc68beed31a6c0f6de4cf701
‣ Public Key:   03a89261c20768ce41930371cd4c0d756c872e96b8ff749ac044199cc7100ccd71
‣ STX Address:  ST1MDWBDVDGAANEH9001HGXQA6XRNK7PX7A7X8M6R
‣ BTC Address:  mq5SjFHAPh93ZnFLc6Jev8yqn2iLg28Q5B
‣ WIF:          cMz2ZSsaVgWPFUkE44zHpJepB4NdwB9L938h53hQfFoot81AZFb3
```

## Bitcoin Staking Accounts

Funded accounts used by the optional `bitcoin-staking` profile. These are separate from the transaction-generation accounts to avoid nonce contention with `tx-broadcaster`.

### Bitcoin Staking 1

```text
‣ Private Key:  d9493653ea195060a599a356bd8381f70f52f007827dd25e7486d14e5197157801
‣ Public Key:   020d6085b50919598386c7e96a252283420eecdf7cbaca4b968e90295e386c2028
‣ STX Address:  ST2N30Q9PQPPPTBFYN4WN7KF3N2KRHZA9QFAABWP4
```

### Bitcoin Staking 2

```text
‣ Private Key:  c47a4264c2bd5b20ddb2ee3f731118555ecf41c63befd998d3bff89f204c0c9701
‣ Public Key:   02303e0b336ce291e545558385521eaab845653ef4d9c7afa8fd445c15f39d6da2
‣ STX Address:  ST3ZPZ54BV6BARTSGGM05PCJ5HA0XRAHYK3T8RSM8
```

### Bitcoin Staking 3

```text
‣ Private Key:  7b546d17e6d8aea6692f456c45489f218700eb3074a11f1a01f9c8c2cdf2a98901
‣ Public Key:   0249cd888fc2e95faf7c82f83f79e20c5e8ef60829edd93ded57ef90542d794909
‣ STX Address:  ST3AY3W1J4F67C5VSD8AZYD6N10P5M8SYT8WQWV40
```

## Testing Accounts

_Unused but funded accounts that may be used to deploy contracts or other txs_

### Deployer Account

_Unused but funded account that may be used to deploy contracts or other txs_

```text
‣ Mnemonic:     keep can record bracket note hip face pudding castle detail few sunset review burger enhance foil lamp estate reopen butter then wasp pen kick
‣ Private Key:  27e27a9c242bcf79784bb8b19c8d875e23aaf65c132d54a47c84e1a5a67bc62601
‣ Public Key:   025fa7693cfe4b7c7beccdd9e4bfe77f77a3779d5a58faeb69ead7d1ba94d64f76
‣ STX Address:  ST2SBXRBJJTH7GV5J93HJ62W2NRRQ46XYBK92Y039
‣ BTC Address:  mwp5EpXXVsZxzQRC7yrDe1CJBsyub9f91n
‣ WIF:          cNvERZ1Ci4NQydr5dTuW8K2JuoyfjLJgYVskrLzBoXREnRVbS9qx
```

### Tester 1

```text
‣ Mnemonic:     turkey collect myth access museum demise beef sugar soccer regret frozen will accuse report carpet act grid always satoshi cruise heavy truck avocado dry
‣ Private Key:  38369c150fa7dd132a09a1baf78675a6af3e0612008f299612445f0a5c9f022601
‣ Public Key:   023b7b8652527648bae8efc9153c9b51ccf69f17547b92c70ac33b07de8124ec91
‣ STX Address:  ST332DWHNM323264X869MKXFZABSE5WZ60EA07TJ1
‣ BTC Address:  myagk4VdbTPZpmJsMiw2bmkY3SmSF9zAp3
‣ WIF:          cPTyPP8MtzppSCidZCCAdvecqakCrJ5NPNPs8N4ENGiB11c93hh6
```

### Tester 2

```text
‣ Mnemonic:     cheap render bench token hobby quiz food home twenty fresh until pool whip reduce snack draft club trim boost consider tired symptom amount utility
‣ Private Key:  c3201a1a063c452dda2c27ed5c5d1f8bd12e0c82a1c55ba79dc542c5414441f801
‣ Public Key:   02ea179e664324f495a74c717f128410503c18724ffa8356c5f9f66b9fb241c87a
‣ STX Address:  ST2FY5WGSFA209NFHDT08NCB8Y9J3P1H19YR2D674
‣ BTC Address:  mv6Mc23a3442ZxAbnfzMoSiev6HrYD1wdj
‣ WIF:          cU7zwyRUPanpZDvjSwsaivNjrqN9d8KYVYJuhPn52zCnELasvBMA
```

### Tester 3

```text
‣ Mnemonic:     mixed recycle enroll celery jar object access west loan quantum country race crouch achieve trend mesh invite inch cake wise gospel kick frog hour
‣ Private Key:  6b1474ff9fd29d281f1f3f204b13989a030b5451cc2e840c8c540328cd580cf801
‣ Public Key:   0205930579d15354f3b536f44113fde6ee0aea830a09ab09e89814260fa9e43501
‣ STX Address:  ST3SW0AXHXFDHGQY2XMMDHN6T7VPY395WS7ZRGQCD
‣ BTC Address:  n3jnhvRqD5S7uLRgXQRUeiyLmwLxAcYGt6
‣ WIF:          cRArJzg1NRQKtJQJSa7bT4EKxoR1QoxjLYyj1c4jLGYgaiQcdsXJ
```
