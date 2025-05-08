// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add any custom configurations here
config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs'];

// Configure asset resolution
config.resolver.assetExts = [...config.resolver.assetExts, 'db', 'mp3', 'ttf', 'obj', 'png', 'jpg'];

// Ensure web support is properly configured
config.resolver.platforms = ['ios', 'android', 'web'];

module.exports = config; 