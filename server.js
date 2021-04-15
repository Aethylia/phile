const http = require("http");
const fs = require("fs");

//num of chars to use in each ID
const ID_LENGTH = 8;
//time before file automatically deleted
const AUTO_DELETE_TIMEOUT = 1000 * 60 * 60 * 24;

//filter for ignoring certain user agents
const uaFilter = /(facebook|discord)/;

const fileInfo = {};
const pendingUploads = {};


//generate an ID of random letters in mixed case
function generateID() {
    let id = "";

    for (let i = 0; i < ID_LENGTH; ++i) {
        let charCode = 0x41 + Math.floor(Math.random() * 26);
        if (Math.random() < 0.5) {
            charCode += 32;
        }
        id += String.fromCharCode(charCode);
    }

    return id;
}


//keeps generating IDs until a new one is found
function generateUniqueID() {
    let id;

    do {
        id = generateID();
    } while (fileInfo[id] !== undefined);

    return id;
}


//send a file normally to the user
function sendFile(res, path) {
    fs.readFile(path, (err, data) => {
        if (err) {
            send404(res);
        }
        else {
            res.end(data);
        }
    });
}


function send404(res) {
    res.writeHead(404, "File not found.");

    fs.readFile("site/404.html", (err, data) => {
        if (err) {
            console.error("Couldn't load 404 file");
        }
        else {
            res.end(data);
        }
    });
}


//sends the file with the given ID to the user
//with a header to have the browser offer to save
//it instead of trying to render it
function sendFileID(res, id) {
    if (fileInfo[id] !== undefined) {
        const filename = fileInfo[id].filename;
        const filePath = "./files/" + id;

        res.writeHead(200, {
            "Content-Length": fs.statSync(filePath).size,
            "Content-Disposition": `attachment; filename="${filename}"`
        });

        const readStream = fs.createReadStream(filePath);
        readStream.pipe(res);

        readStream.on("finish", () => {
            console.log(`Sent ${id}[${fileInfo[id].dCount}]`);  

            if (fileInfo[id].dCount === 0) {
                deleteFile(id);
            }
        });
    }
    else {
        send404(res);
    }
}


function deleteFile(id) {
    if (fileInfo[id] !== undefined) {
        fs.unlink("./files/" + id, err => {
            if (err) {
                console.log("Error deleting " + id);
            }
            else {
                console.log("Deleted " + id);
            }
        });

        delete fileInfo[id];
        delete pendingUploads[id];
    }
}


//parse the number of downloads
//defaults to 1, only accepts numbers
//greater than 0
function parseDCount(numString) {
    let n = 1;
    
    if (numString !== "")
    {
        let parsed = parseInt(numString);

        if (!isNaN(parsed) && parsed > 0)
        {
            n = parsed;
        }
    }

    return n;
}


function handleGET(req, res) {
    if (req.url === "/") {
        sendFile(res, "site/index.html");
    }
    else if (req.url.includes(".")) {
        //prevent simple directory traversal
        const regex = /\/\.\./g;
        const path = req.url.replace(regex, "");
        sendFile(res, "site/" + path.substr(1));
    }
    else {
        const id = req.url.substr(1);
        
        if (fileInfo[id])
        {      
            sendFileID(res, id);
            --fileInfo[id].dCount;
        }
        else
        {
            send404(res);
        }
    }
}


function handlePOST(req, res) {
    if (req.url === "/new") {
        const size = parseInt(req.headers["x-filesize"]);

        if (!isNaN(size)) {
            const id = generateUniqueID();
            const writeStream = fs.createWriteStream(`./files/${id}`);

            writeStream.on("finish", () => {
                console.log(`${id} fully received`);

                writeStream.res.writeHead(200, {"X-Done": "y"});
                writeStream.res.end();
                
                setTimeout(deleteFile, AUTO_DELETE_TIMEOUT, id);
                delete pendingUploads[id];
            });

            pendingUploads[id] = {id, size, writeStream, received: 0, chunks: [], nextChunk: 0};
            fileInfo[id] = {
                filename: req.headers["x-filename"],
                dCount: parseDCount(req.headers["x-dcount"])
            };

            console.log(`New file requested id: ${id}, size: ${size}`);
            res.writeHead(200, {"X-File-ID": id.toString()});
            res.end();
        }
        else {
            res.writeHead(500);
            res.end();
        }
    }
    else if (req.url === "/data") {
        const id = req.headers["x-file-id"];
        const pending = pendingUploads[id];
        
        if (pending) {
            const blockSize = parseInt(req.headers["content-length"]);

            if (isNaN(blockSize)) {
                res.writeHead(500);
                res.end();
                return;
            }

            const data = Buffer.alloc(blockSize);
            let bytesReceived = 0;
            
            req.on("data", chunk => {
                chunk.copy(data, bytesReceived, 0);
                bytesReceived += chunk.length;
            });
            
            req.on("end", () => {
                const blockID = req.headers["x-block-id"];
                pending.received += bytesReceived;
                
                //add all consecutive chunks to the sream
                pending.chunks[blockID] = data;

                let c = pending.chunks[pending.nextChunk];
                while (c) {
                    pending.writeStream.write(c, err => {
                        if (err) {
                            console.log("Error writing data: " + err);
                            res.writeHead(500);
                            res.end();
                            
                            pending.writeStream.close();
                            deleteFile(id);
                        }
                    });
                    ++pending.nextChunk;
                    c = pending.chunks[pending.nextChunk];
                }

                if (pending.received >= pending.size) {
                    //writeStream 'finish' event will handle the response
                    pending.writeStream.res = res;
                    pending.writeStream.end();
                }
                else {
                    res.writeHead(200);
                    res.end();
                }
            });
        }
        else {
            console.log("Data sent to /data with no pending upload at ID " + id);
        }
    }

}


const server = http.createServer((req, res) => {
    const ua = req.headers["user-agent"];

    //ignore requests with a user agent
    //matching the filter rules
    if (!uaFilter.test(ua))
    {
        if (req.method === "GET")
        {
            handleGET(req, res);
        }
        else if (req.method === "POST")
        {
            handlePOST(req, res);
        }
    }
    else
    {
        console.log("Filtered UA");
        //send response to filtered agents
        //so they know not to retry
        res.writeHead(403, "Filtered UA");
        res.end();
    }
});


const options = {
    port: 1880,
    host: "0.0.0.0"
}

const filesDir = "./files";

if (!fs.existsSync(filesDir)) {
    fs.mkdirSync(filesDir);
}

server.listen(options, () => {
    console.log(`Listening on ${options.port}`);
});