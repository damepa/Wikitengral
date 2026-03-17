# Stage 1: Build the frontend
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Production runner
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# Copy package files and install production dependencies
# We need tsx and typescript to run the server.ts file
COPY package*.json ./
RUN npm install

# Copy the built frontend and the server code
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./server.ts

# Expose the port
EXPOSE 3000

# Start the application
CMD ["npm", "run", "start"]
