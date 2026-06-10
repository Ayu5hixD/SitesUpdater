const fs = require("fs");
const axios = require("axios");

const FILE_PATH = "urls.json";

// Read the urls.json file
function urlsJson() {
  try {
    const data = fs.readFileSync(FILE_PATH, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading ${FILE_PATH}:`, error);
    process.exit(1);
  }
}

// Extract domain (origin) from URL without trailing slash
function getDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.origin;
  } catch (error) {
    console.error(`Error parsing URL ${url}:`, error);
    return url;
  }
}

// Check if original URL has a trailing slash in path
function hasTrailingSlash(url) {
  return url.endsWith("/") && !url.endsWith("://");
}

// Check URL and return new URL if domain redirected
async function checkUrl(url) {
  try {
    // Set timeout to 10 seconds to avoid hanging
    const response = await axios.head(url, {
      maxRedirects: 0,
      timeout: 10000,
      validateStatus: (status) => true,
    });

    // If status is 200, no change needed
    if (response.status === 200) {
      console.log(`✅ ${url} is valid (200 OK)`);
      return null;
    } else if (response.status >= 300 && response.status < 400) {
      // Handle redirects
      const newLocation = response.headers.location;
      if (newLocation) {
        // If it's a relative redirect, construct the full URL
        let fullRedirectUrl = newLocation;
        if (!newLocation.startsWith("http")) {
          const baseUrl = new URL(url);
          fullRedirectUrl = new URL(newLocation, baseUrl.origin).toString();
        }

        console.log(`🔄 ${url} redirects to ${fullRedirectUrl}`);

        // Get the new domain
        const newDomain = getDomain(fullRedirectUrl);

        // Check if original URL had a trailing slash
        const needsTrailingSlash = hasTrailingSlash(url);

        // Create new URL: new domain + trailing slash if the original had one
        let finalUrl = newDomain;
        if (needsTrailingSlash) {
          finalUrl += "/";
        }

        console.log(
          `Will update to: ${finalUrl} (preserved trailing slash: ${needsTrailingSlash})`
        );
        return finalUrl;
      }
    } else {
      console.log(`⚠️ ${url} returned status ${response.status}`);
    }
  } catch (error) {
    // Try GET request if HEAD fails
    try {
      const response = await axios.get(url, {
        maxRedirects: 0,
        timeout: 10000,
        headers: {
          Referer: url,
          Origin: url,
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
        validateStatus: (status) => true,
      });

      if (response.status === 200) {
        console.log(`✅ ${url} is valid (200 OK)`);
        return null;
      } else if (response.status >= 300 && response.status < 400) {
        // Handle redirects
        const newLocation = response.headers.location;
        if (newLocation) {
          console.log(`🔄 ${url} redirects to ${newLocation}`);

          let fullRedirectUrl = newLocation;
          if (!newLocation.startsWith("http")) {
            const baseUrl = new URL(url);
            fullRedirectUrl = new URL(newLocation, baseUrl.origin).toString();
          }

          // Get the new domain
          const newDomain = getDomain(fullRedirectUrl);

          // Check if original URL had a trailing slash
          const needsTrailingSlash = hasTrailingSlash(url);

          // Create new URL: new domain + trailing slash if the original had one
          let finalUrl = newDomain;
          if (needsTrailingSlash) {
            finalUrl += "/";
          }

          console.log(
            `Will update to: ${finalUrl} (preserved trailing slash: ${needsTrailingSlash})`
          );
          return finalUrl;
        }
      } else {
        console.log(`⚠️ ${url} returned status ${response.status}`);
      }
    } catch (getError) {
      if (getError.response) {
        console.log(`⚠️ ${url} returned status ${getError.response.status}`);
      } else if (getError.code === "ECONNABORTED") {
        console.log(`⌛ ${url} request timed out`);
      } else if (getError.code === "ENOTFOUND") {
        console.log(`❌ ${url} domain not found`);
      } else {
        console.log(`❌ Error checking ${url}: ${getError.message}`);
      }
    }
  }

  // Return null if no change or error
  return null;
}

// Main function
async function main() {
  const providers = urlsJson();
  let hasChanges = false;

  // const SKIP_KEYS = new Set(['nfverifyurl']);
  // Process each provider
  for (const [name, url] of Object.entries(providers)) {
    // if (SKIP_KEYS.has(name)) {
    //   console.log(`⏩ Skipping ${name} (${url}) as configured`);
    //   continue;
    // }

    console.log(`Checking ${name} (${url})...`);

    try {
      const newUrl = await checkUrl(url);
      if (newUrl && newUrl !== url) {
        providers[name] = newUrl; // Update the URL in providers object
        hasChanges = true;
        console.log(`Updated ${name} URL from ${url} to ${newUrl}`);
      }
    } catch (error) {
      console.log(`❌ Error processing ${url}: ${error.message}`);
    }
  }

  // Write changes back to file if needed
  if (hasChanges) {
    const jsonString = JSON.stringify(providers, null, 2);
    fs.writeFileSync(FILE_PATH, jsonString);
    console.log(`✅ Updated ${FILE_PATH} with new URLs`);
  } else {
    console.log(`ℹ️ No changes needed for ${FILE_PATH}`);
  }
}

// Execute main function with error handling
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
