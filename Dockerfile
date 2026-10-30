FROM public.ecr.aws/docker/library/node:20-alpine
WORKDIR /app

# Install dependencies first so Docker can cache this layer.
COPY package*.json ./
ENV NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000
RUN npm ci --omit=dev

# Then copy the source code.
COPY . .

EXPOSE 8081
USER node
CMD ["node", "server.js"]
