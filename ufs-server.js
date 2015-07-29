if (Meteor.isServer) {
    fs = Npm.require('fs');
    Future = Npm.require('fibers/future');
    mkdirp = Npm.require('mkdirp');
    zlib = Npm.require('zlib');

    // Create the temporary upload dir
    Meteor.startup(function () {
        createTempDir();
    });

    Meteor.methods({
        /**
         * Completes the file transfer
         * @param fileId
         * @param storeName
         */
        ufsComplete: function (fileId, storeName) {
            check(fileId, String);
            check(storeName, String);

            var store = UploadFS.getStore(storeName);

            // Check arguments
            if (!store) {
                throw new Meteor.Error(404, 'store "' + storeName + '" does not exist');
            }

            // Check that file exists and is owned by current user
            if (store.getCollection().find({_id: fileId, userId: this.userId}).count() < 1) {
                throw new Meteor.Error(404, 'file "' + fileId + '" does not exist');
            }

            var fut = new Future();
            var tmpFile = UploadFS.getTempFilePath(fileId);
            var writeStream = store.getWriteStream(fileId);
            var readStream = fs.createReadStream(tmpFile, {
                flags: 'r',
                encoding: null,
                autoClose: true
            });

            readStream.on('error', function (err) {
                console.error(err);
                store.delete(fileId);
                fut.throw(err);
            });

            writeStream.on('error', function (err) {
                console.error(err);
                store.delete(fileId);
                fut.throw(err);
            });

            writeStream.on('finish', Meteor.bindEnvironment(function () {
                // Delete the temporary file
                Meteor.setTimeout(function () {
                    fs.unlink(tmpFile);
                }, 500);

                // Sets the file URL when file transfer is complete,
                // this way, the image will loads entirely.
                store.getCollection().update(fileId, {
                    $set: {
                        complete: true,
                        uploading: false,
                        uploadedAt: new Date(), // todo use UTC date
                        url: store.getFileURL(fileId)
                    }
                });

                fut.return(true);
            }));

            // Execute transformation
            store.transform(readStream, writeStream, fileId);

            return fut.wait();
        },

        /**
         * Saves a chunk of file
         * @param chunk
         * @param fileId
         * @param storeName
         * @return {*}
         */
        ufsWrite: function (chunk, fileId, storeName) {
            check(fileId, String);
            check(storeName, String);

            // Check arguments
            if (!(chunk instanceof Uint8Array)) {
                throw new Meteor.Error(400, 'chunk is not an Uint8Array');
            }
            if (chunk.length <= 0) {
                throw new Meteor.Error(400, 'chunk is empty');
            }

            var store = UploadFS.getStore(storeName);
            if (!store) {
                throw new Meteor.Error(404, 'store ' + storeName + ' does not exist');
            }

            // Check that file exists, is not complete and is owned by current user
            if (store.getCollection().find({_id: fileId, complete: false, userId: this.userId}).count() < 1) {
                throw new Meteor.Error(404, 'file ' + fileId + ' does not exist');
            }

            var fut = new Future();
            var tmpFile = UploadFS.getTempFilePath(fileId);
            fs.appendFile(tmpFile, new Buffer(chunk), function (err) {
                if (err) {
                    console.error(err);
                    fs.unlink(tmpFile);
                    fut.throw(err);
                } else {
                    fut.return(chunk.length);
                }
            });
            return fut.wait();
        }
    });

    // Listen HTTP requests to serve files
    WebApp.connectHandlers.use(function (req, res, next) {
        // Quick check to see if request should be catch
        if (req.url.indexOf(UploadFS.config.storesPath) === -1) {
            next();
            return;
        }

        // Remove store path
        var path = req.url.substr(UploadFS.config.storesPath.length + 1);

        // Get store and file
        var regExp = new RegExp('^\/([^\/]+)\/([^\/]+)$');
        var match = regExp.exec(path);

        if (match !== null) {
            // Get store
            var storeName = match[1];
            var store = UploadFS.getStore(storeName);
            if (!store) {
                res.writeHead(404, {});
                res.end();
                return;
            }

            // Get file from database
            var fileId = match[2].replace(/\.[^.]+$/, '');
            var file = store.getCollection().findOne(fileId);
            if (!file) {
                res.writeHead(404, {});
                res.end();
                return;
            }

            // Execute callback to do some check (eg. security check)
            if (typeof store.onRead === 'function') {
                store.onRead.call(store, fileId, req, res);
            }

            try {
                // Get file stream
                var rs = store.getReadStream(fileId);
                var accept = req.headers['accept-encoding'] || '';

                // Compress data if supported by the client
                if (accept.match(/\bdeflate\b/)) {
                    res.writeHead(200, {
                        'Content-Encoding': 'deflate',
                        'Content-Type': file.type
                    });
                    rs.pipe(zlib.createDeflate()).pipe(res);

                } else if (accept.match(/\bgzip\b/)) {
                    res.writeHead(200, {
                        'Content-Encoding': 'gzip',
                        'Content-Type': file.type
                    });
                    rs.pipe(zlib.createGzip()).pipe(res);

                } else {
                    res.writeHead(200, {});
                    rs.pipe(res);
                }
            } catch (err) {
                console.error('Cannot read file ' + fileId);
                throw err;
            }

        } else {
            next();
        }
    });

    function createTempDir() {
        var path = UploadFS.config.tmpDir;
        mkdirp(path, function (err) {
            if (err) {
                console.error('ufs: cannot create tmpDir ' + path);
            } else {
                console.log('ufs: created tmpDir ' + path);
            }
        });
    }
}