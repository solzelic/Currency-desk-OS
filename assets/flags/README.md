# Currency flags

A flag for every currency the market feeds offer, from [flag-icons](https://github.com/lipis/flag-icons) 7.2.3 (MIT licence), 4:3 SVG, the set the Rates v2.5 design uses. The first 28 came with the design; the rest are copied unchanged from the package.
Which currency uses which file is `shared/currency-face.js` (`FLAG_FILES`). XAF, XCD, XOF and XPF are each shared by several countries, so they have no flag and show a plain tile.
`server/tests/currency-face.test.ts` checks that every file is used, every currency the feeds offer has one, and no file holds script.
