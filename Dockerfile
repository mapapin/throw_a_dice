FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json server.mjs ./
RUN npm ci
COPY public ./public
RUN npm run build
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
