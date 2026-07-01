FROM node:20-bookworm AS builder

RUN apt-get update && apt-get install -y curl gettext-base jq

WORKDIR /root
COPY ./stacking/package.json /root/
RUN npm i

COPY ./stacking/*.ts /root/
COPY ./stacking/contracts /root/contracts

CMD ["npx", "tsx", "/root/stacking.ts"]
