# Use Node 18 with Alpine for smaller image size
FROM node:18-alpine

# Set environment variables
ENV EXPO_PUBLIC_SNACK_ENV=development \
    NODE_OPTIONS="--max_old_space_size=4096"

# Install dependencies in a single layer to reduce image size
RUN apk add --no-cache git

# Set working directory
WORKDIR /app

# Copy package.json 
COPY runtime/package.json ./

# Create packages directory structure and copy the local packages
RUN mkdir -p ../packages/snack-babel-standalone ../packages/snack-content ../packages/snack-require-context

# Copy the local packages to their expected relative locations
COPY packages/snack-babel-standalone ../packages/snack-babel-standalone/
COPY packages/snack-content ../packages/snack-content/
COPY packages/snack-require-context ../packages/snack-require-context/

# Install dependencies including local packages
RUN yarn install --production=false --network-timeout 600000 && \
    yarn add --dev @types/react-native && \
    yarn cache clean

# Copy only necessary files
COPY runtime/metro.config.js ./
COPY runtime/app.json ./
COPY runtime/babel.config.js ./
COPY runtime/index.js ./
COPY runtime/src/ ./src/
COPY runtime/assets/ ./assets/
COPY runtime/web/ ./web/

# Expose the port
EXPOSE 19006

# Start the web server
CMD ["npx", "expo", "start", "--web", "--host", "lan", "--port", "19006", "--no-dev"] 