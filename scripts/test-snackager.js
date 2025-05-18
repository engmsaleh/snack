const fetch = require('node-fetch');

async function testSnackager() {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.error('Usage: node scripts/test-snackager.js <package-name> <package-version> <platforms> <sdk-version> [snackager-base-url]');
    console.error('Example: node scripts/test-snackager.js expo-status-bar "~1.11.1" "ios,android,web" "50.0.0"');
    process.exit(1);
  }

  const [packageName, packageVersion, platforms, sdkVersion, baseUrl = 'http://localhost:3001'] = args;

  // URL-encode the package name and version as they can contain special characters like '@' or '/' or '~'
  const encodedPackageName = encodeURIComponent(packageName);
  const encodedPackageVersion = encodeURIComponent(packageVersion);

  const url = `${baseUrl}/bundle/${encodedPackageName}@${encodedPackageVersion}?version_snackager=true&sdkVersion=${sdkVersion}&platforms=${platforms}`;

  console.log(`Requesting URL: ${url}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      }
    });

    console.log(`Status Code: ${response.status}`);
    
    const responseBody = await response.json();
    console.log('Response Body:');
    console.log(JSON.stringify(responseBody, null, 2));

    if (responseBody.pending) {
      console.log('\nBundle is pending. You may need to run this script again after a short delay to get the final status.');
    }

  } catch (error) {
    console.error('Error making request to Snackager:', error);
  }
}

testSnackager(); 