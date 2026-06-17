FROM node:20-bookworm AS builder

RUN apt-get update && apt-get install -y curl gettext-base jq

WORKDIR /root
COPY ./stacking/package.json /root/
RUN npm i

COPY ./stacking/stacking.ts ./stacking/common.ts ./stacking/tx-broadcaster.ts ./stacking/pox5-setup.ts ./stacking/bitcoin-staking.ts /root/

CMD ["npx", "tsx", "/root/stacking.ts"]
