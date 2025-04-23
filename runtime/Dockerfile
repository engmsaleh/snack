# Use a specific Node version consistent with the project (from root package.json)
ARG node_version=18.17.1
FROM node:${node_version}-alpine as base

WORKDIR /app

# Copy root package.json and yarn.lock to leverage Docker cache
COPY package.json yarn.lock ./
# Copy workspaces definition from turbo.json if needed for yarn install,
# or just install dependencies for the runtime package specifically later.

# Copy the runtime directory contents
COPY runtime/ ./runtime/
# Copy necessary packages depended upon by runtime
# We might need to refine this based on actual dependencies needed at runtime vs build time
COPY packages/snack-babel-standalone ./packages/snack-babel-standalone
COPY packages/snack-content ./packages/snack-content
COPY packages/snack-require-context ./packages/snack-require-context
# Add other packages/* if needed by runtime

WORKDIR /app/runtime

# Install dependencies *within* the runtime directory
# Use --frozen-lockfile if runtime/yarn.lock exists and is reliable
RUN yarn install --frozen-lockfile

# Expo web default port is 19006
EXPOSE 19006

# Environment variable used in runtime/package.json scripts
ENV EXPO_PUBLIC_SNACK_ENV=development

# Use yarn run to execute the script defined in package.json, passing through host/port args
CMD ["yarn", "run", "web", "--", "--host", "lan", "--port", "19006"] 