FROM oven/bun:1
WORKDIR /app
COPY package*.json ./
RUN bun install --production
COPY . .
EXPOSE 3091
CMD ["bun", "run", "src/index.ts"]
