FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    REKORDERLIG_DB=/data/rekorderlig.db

EXPOSE 4173
CMD ["npm", "start"]
