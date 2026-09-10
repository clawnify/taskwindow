/**
 * The Chrome Web Store listing. A store install has this fixed extension id,
 * and Chrome stamps every request the extension makes with
 * `Origin: chrome-extension://<id>` — another extension cannot forge it, and a
 * process outside Chrome can already read the token file — so a pairing
 * request from this origin gets the daemon token without a code.
 */
export const STORE_EXTENSION_ID = "adbfpkbjndcpjihceobeegkokblgifpe";
export const STORE_LISTING_URL = `https://chromewebstore.google.com/detail/${STORE_EXTENSION_ID}`;
export const STORE_ORIGIN = `chrome-extension://${STORE_EXTENSION_ID}`;
