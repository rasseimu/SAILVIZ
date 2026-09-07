FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=8000 DATA_DIR=/data
VOLUME /data
EXPOSE 8000
CMD ["node", "server/index.js"]
