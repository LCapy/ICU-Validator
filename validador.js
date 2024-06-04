const fs = require('fs');
const path = require('path');
const MessageFormat = require('@messageformat/core');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const { jsPDF } = require('jspdf');
const JSZip = require('jszip');

const options = {
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    attributesGroupName: "PROPS_",
    processEntities: true
};

let errorLog = [];
let modifiedFiles = {};
let zipInstances = {};

const tempDir = 'temp';

// Ensure temp directory exists
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

function extractIdAndTarget(transUnit, targetLanguage, filename) {
    const id = transUnit.PROPS_["@_id"];
    const source = transUnit.source;
    const target = transUnit.target;

    if (target.trim() === "" && source.trim() !== "") {
        logError(filename, id, source, target, targetLanguage, "Validation Error", `Source is not empty but target is empty. Plural rules for ${targetLanguage}: ${getPluralRules(targetLanguage)}`);
        return null;
    } else if (target.trim() !== "" && source.trim() === "") {
        logError(filename, id, source, target, targetLanguage, "Validation Warning", `Source is empty but target is not empty. This might be valid and can be ignored. Plural rules for ${targetLanguage}: ${getPluralRules(targetLanguage)}`);
        return null;
    } else if (source.trim() === "") return null;
    return { source, target, id };
}

function validateTarget(filename, source, target, targetLanguage, id) {
    try {
        const icupluralselect = /(?:(plural|select),)/;
        const hasPluralSelectSource = icupluralselect.test(source);
        const hasPluralSelectTarget = icupluralselect.test(target);
        const param = /\$?{[a-zA-Z_-]+}}?/g;
        const source_params = [...source.matchAll(param)];
        const source_param_array = source_params.map(match => match[0]);
        const target_params = [...target.matchAll(param)];
        const target_param_array = target_params.map(match => match[0]);

        if (source_params.length) {
            let missingParam = [];
            let extraParam = [];
            if (target_param_array.length > source_param_array.length) {
                for (const param of target_param_array) {
                    if (!source_param_array.includes(param)) {
                        extraParam.push(param);
                    }
                }
                if (extraParam.length) throw new Error(`Variable [${extraParam.join(", ")}] not found in source`);
            } else {
                for (const param of source_param_array) {
                    if (!target_param_array.includes(param)) {
                        missingParam.push(param);
                    }
                }
                if (missingParam.length) throw new Error(`Variable [${missingParam.join(", ")}] missing in target`);
            }
        } else if (target_params.length > source_params.length) throw new Error(`Variable [${target_params.join(", ")}] not found in source`);

        if (hasPluralSelectSource) {
            if (!hasPluralSelectTarget) throw new Error(`Plural or Select argument found in source but is missing in target. Plural rules for ${targetLanguage}: ${getPluralRules(targetLanguage)}`);
        }

        const mf = new MessageFormat(targetLanguage);
        mf.compile(target);
    } catch (error2) {
        logError(filename, id, source, target, targetLanguage, "Compilation Error", error2.message);
    }
}

function logError(filename, id, source, target, targetLanguage, errorType, message) {
    errorLog.push({ File: filename, ID: id, Source: source, Target: target, Language: targetLanguage, ErrorType: errorType, Description: message });
    console.error(`Error validating stringID ${id} for the language ${targetLanguage} in file ${filename}`);
    console.warn(`ID: ${id}`);
    console.warn(`Source: ${source}`);
    console.warn(`Target: ${target}`);
    console.error(message);
    console.log('');
}

function getPluralRules(language) {
    const pluralRules = new Intl.PluralRules(language);
    const examples = {
        "zero": pluralRules.select(0),
        "one": pluralRules.select(1),
        "two": pluralRules.select(2),
        "few": pluralRules.select(3),
        "many": pluralRules.select(5),
        "other": pluralRules.select(100)
    };
    return JSON.stringify(examples, null, 2);
}

function removeComments(xmlContent) {
    // Remove XML comments
    xmlContent = xmlContent.replace(/<!--[\s\S]*?-->/g, '');
    // Remove <note> elements and their contents
    xmlContent = xmlContent.replace(/<note[\s\S]*?<\/note>/g, '');
    return xmlContent;
}

function processDirectory(directoryPath) {
    let files;
    try {
        files = fs.readdirSync(directoryPath);
    } catch (error) {
        console.error(`'${directoryPath}' doesn't exist or is not a valid folder`);
        process.exit(1);
    }
    const desiredExtensions = ['.xlf', '.xliff'];
    const filteredFiles = files.filter((file) => {
        const ext = path.extname(file).toLowerCase();
        return desiredExtensions.includes(ext);
    });
    if (!filteredFiles.length) {
        if (directoryPath === "." || directoryPath === "./") console.warn(`Current directory doesn't contain any file with extension ${desiredExtensions}`);
        else console.warn(`${directoryPath} doesn't contain any file with extension ${desiredExtensions}`);
        process.exit(0);
    }
    for (const filename of filteredFiles) {
        console.log(`Processing ${path.join(directoryPath, filename)}`);
        let fileContent = fs.readFileSync(path.join(directoryPath, filename), 'utf-8');
        fileContent = removeComments(fileContent); // Remove comments before parsing
        const parser = new XMLParser(options);
        let jsonObj = parser.parse(fileContent);
        const transUnits = jsonObj.xliff.file.body['trans-unit'];
        const targetLanguage = jsonObj.xliff.file.PROPS_["@_target-language"];
        for (const transUnit of transUnits) {
            const result = extractIdAndTarget(transUnit, targetLanguage, filename);
            if (result) {
                const { source, target, id } = result;
                try {
                    validateTarget(filename, source, target, targetLanguage, id);
                } catch {
                    // Do Nothing
                }
            }
        }
        modifiedFiles[filename] = jsonObj; // Store the parsed object for potential modification
    }
    if (errorLog.length) {
        saveErrorLog();
        console.log('Some errors occurred, see logs');
        process.exit(1);
    } else {
        saveModifiedFiles();
        console.log('ICU strings look good :)');
    }
}

function saveErrorLog() {
    const doc = new jsPDF();
    let y = 10;
    doc.setFontSize(10);
    doc.text('Error Report', 10, y);
    y += 10;

    errorLog.forEach(error => {
        const { File, ID, Source, Target, Language, ErrorType, Description } = error;
        doc.text(`File: ${File}`, 10, y);
        y += 6;
        doc.text(`ID: ${ID}`, 10, y);
        y += 6;
        doc.text(`Source: ${Source}`, 10, y);
        y += 6;
        doc.text(`Target: ${Target}`, 10, y);
        y += 6;
        doc.text(`Language: ${Language}`, 10, y);
        y += 6;
        doc.text(`ErrorType: ${ErrorType}`, 10, y);
        y += 6;
        doc.text(`Description: ${Description}`, 10, y);
        y += 10;
    });

    doc.save('error_report.pdf');
}

function saveModifiedFiles() {
    const builder = new XMLBuilder(options);
    for (const [filename, jsonObj] of Object.entries(modifiedFiles)) {
        const xmlContent = builder.build(jsonObj);
        fs.writeFileSync(path.join(tempDir, filename), xmlContent, 'utf-8');
        console.log(`Saved modified file: ${filename}`);
    }
}

async function modifyZipFiles() {
    for (const [fileName, zip] of Object.entries(zipInstances)) {
        const xlfFiles = Object.keys(modifiedFiles).filter(file => file.endsWith('.xlf'));
        for (const xlfFile of xlfFiles) {
            const xmlContent = fs.readFileSync(path.join(tempDir, xlfFile), 'utf-8');
            zip.file(xlfFile, xmlContent);
        }
        const modifiedBlob = await zip.generateAsync({ type: 'nodebuffer' });
        fs.writeFileSync(path.join(tempDir, fileName), modifiedBlob);
    }
}

async function revalidateFiles() {
    errorLog = []; // Reset error log
    for (const [fileName, zip] of Object.entries(zipInstances)) {
        const xlfFiles = Object.keys(modifiedFiles).filter(file => file.endsWith('.xlf'));
        for (const xlfFile of xlfFiles) {
            const xmlContent = fs.readFileSync(path.join(tempDir, xlfFile), 'utf-8');
            processXLFContent(xmlContent, xlfFile, fileName, zip);
        }
    }
    if (errorLog.length) {
        saveErrorLog();
        console.log('Some errors occurred, see logs');
        return false;
    } else {
        console.log('ICU strings look good :)');
        return true;
    }
}

function processXLFContent(content, fileName, wsxzFileName, zip) {
    const parser = new XMLParser(options);
    let jsonObj = parser.parse(content);
    const transUnits = jsonObj.xliff.file.body['trans-unit'];
    const targetLanguage = jsonObj.xliff.file.PROPS_["@_target-language"];

    for (const transUnit of transUnits) {
        const result = extractIdAndTarget(transUnit, targetLanguage, fileName);
        if (result) {
            const { source, target, id } = result;
            try {
                validateTarget(fileName, source, target, targetLanguage, id);
            } catch {
                // Do Nothing
            }
        }
    }
    modifiedFiles[fileName] = jsonObj; // Store the parsed object for potential modification
}

async function runValidator(directoryPath) {
    processDirectory(directoryPath);
    await modifyZipFiles();
    let allGood = await revalidateFiles();
    while (!allGood) {
        await modifyZipFiles();
        allGood = await revalidateFiles();
    }
    console.log('Validation and modification process completed successfully.');
}

// Run the validator with the provided directory path
const directoryPath = process.argv[2];
if (!directoryPath) {
    console.log('Usage: node validador.js <directory_path>');
} else {
    runValidator(directoryPath);
}
