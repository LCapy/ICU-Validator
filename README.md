# ICU Validator

This project is a web-based tool for validating ICU strings inside WSXZ packages. 
It removes comments and validates the contents of `.xlf` files within WSXZ packages.

## Features

- Validates the contents of the `.xlf` files, including ICU rules.
- Removes comments from `.xlf` files within WSXZ packages.
- Provides a report of errors and modifications.
- Allows downloading modified packages and validation reports.

## Usage

1. **Select Packages**: Click on "Select Package(s)" to upload your WSXZ packages.
2. **Revalidate**: Fix the errors in the yellow column and click "Apply Change". Then click on "Revalidate Packages".
3. **Download**: Click on "Download Deliverables" to download the modified packages and a PDF report.

## Hosting

This project is hosted using GitHub Pages. 
You can access it [here](https://lcapy.github.io/ICU-Validator/).

## Files

- `index.html`: The main HTML file for the tool.
- `fast-xml-parser.min.js`: XML parser library.
- `html2canvas.min.js`: Library for rendering HTML elements to canvas.
- `jspdf.umd.min.js`: PDF generation library.
- `jszip.min.js`: Library for creating and managing ZIP files.
- `messageformat.js` and `messageformat.min.js`: Library for handling ICU message formats.
- `validador.js`: Custom JavaScript for handling the validation logic.
- `xlsx.full.min.js`: Library for handling Excel files.

## Contributing

Feel free to open issues or submit pull requests for improvements and bug fixes.
