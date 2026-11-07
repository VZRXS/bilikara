# Local QR reader

`qr-decoder.js` is the unmodified browser distribution `dist/jsQR.js` from
[jsQR 1.4.0](https://github.com/cozmo/jsQR), distributed under Apache-2.0;
`qr-decoder.LICENSE` contains the complete upstream license, omitting only its
redundant final empty line to meet repository whitespace rules. It runs locally,
without a runtime CDN, network requests, image upload or persistent storage.

Source package: `https://registry.npmjs.org/jsqr/-/jsqr-1.4.0.tgz`.
Verify its npm SHA-512 integrity before extracting the two named files:
`sha512-dxLob7q65Xg2DvstYkRpkYtmKm2sPJ9oFhrhmudT1dZvNFFTlroai3AWSpLey/w5vMcLBXRgOJsbXpdN9HzU/A==`.

- JavaScript SHA-256: `bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859`.
- Upstream license SHA-256: `c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08`.
- Repository license SHA-256 after removing one final LF byte:
  `b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1`.

`ktv-scanner.js` bounds image size and decode dimensions, checks for ambiguous
multiple codes, retires pending reads/camera acquisition, and stops tracks on
exit. Browser/native camera behavior and real KTV photographs require separate
device verification; a successful synthetic QR decode does not qualify them.
