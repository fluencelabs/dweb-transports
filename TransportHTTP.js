const Transport = require('./Transport'); // Base class for TransportXyz
const Transports = require('./Transports'); // Manage all Transports that are loaded
const httptools = require('./httptools'); // Expose some of the httptools so that IPFS can use it as a backup
const Url = require('url');
const stream = require('readable-stream');
const debug = require('debug')('dweb-transports:http');
const canonicaljson = require('@stratumn/canonicaljson');



defaulthttpoptions = {
    urlbase: 'https://dweb.me',
    heartbeat: { delay: 30000 } // By default check twice a minute
};

servercommands = {  // What the server wants to see to return each of these
    rawfetch: "contenthash",   // was content/rawfetch which should still work.
    rawstore: "contenturl/rawstore",
    rawadd: "void/rawadd",
    rawlist: "metadata/rawlist",
    get:    "get/table",
    set:    "set/table",
    delete: "delete/table",
    keys:    "keys/table",
    getall:    "getall/table"
};


class TransportHTTP extends Transport {
  /* Subclass of Transport for handling HTTP - see API.md for docs

    options {
        urlbase:    e.g. https://dweb.me    Where to go for URLS like /arc/...
        heartbeat: {
            delay       // Time in milliseconds between checks - 30000 might be appropriate - if missing it wont do a heartbeat
            statusCB    // Callback  cb(transport) when status changes
        }
    }
   */

    constructor(options) {
        super(options); // These are now options.http
        this.options = options;
        this.urlbase = options.urlbase; // e.g. https://dweb.me
        this.supportURLs = ['contenthash', 'http','https'];
        this.supportFunctions = ['fetch', 'store', 'add', 'list', 'reverse', 'newlisturls', "get", "set", "keys", "getall", "delete", "newtable", "newdatabase"]; //Does not support: listmonitor - reverse is disabled somewhere not sure if here or caller
        this.supportFeatures = ['noCache'];
        if (typeof window === "undefined") {
            // running in node, can support createReadStream,  (browser can't - see createReadStream below)
            this.supportFunctions.push("createReadStream");
        }
        // noinspection JSUnusedGlobalSymbols
        this.supportFeatures = ['fetch.range', 'noCache'];
        this.name = "HTTP";             // For console log etc
        this.status = Transport.STATUS_LOADED;
    }

    static setup0(options) {
        let combinedoptions = Transport.mergeoptions(defaulthttpoptions, options.http);
        try {
            let t = new TransportHTTP(combinedoptions);
            Transports.addtransport(t);
            return t;
        } catch (err) {
            console.error("HTTP unable to setup0", err.message);
            throw err;
        }
    }

    p_setup1(statusCB) {
        return new Promise((resolve, unusedReject) => {
            this.status = Transport.STATUS_STARTING;
            if (statusCB) statusCB(this);
            this.updateStatus((unusedErr, unusedRes) => {
                if (statusCB) statusCB(this);
                this.startHeartbeat(this.options.heartbeat);
                resolve(this);  // Note always resolve even if error from p_status as have set status to failed
            });
        })
    }

    async p_status(cb) { //TODO-API
        /*
        Return (via cb or promise) a numeric code for the status of a transport.
         */
        if (cb) { try { this.updateStatus(cb) } catch(err) { cb(err)}} else { return new Promise((resolve, reject) => { try { this.updateStatus((err, res) => { if (err) {reject(err)} else {resolve(res)} })} catch(err) {reject(err)}})} // Promisify pattern v2f
    }
    updateStatus(cb) { //TODO-API
        this.updateInfo((err, res) => {
            if (err) {
                debug("Error status call to info failed %s", err.message);
                this.status = Transport.STATUS_FAILED;
                cb(null, this.status); // DOnt pass error up,  the status indicates the error
            } else {
                this.info = res;    // Save result
                this.status = Transport.STATUS_CONNECTED;
                cb(null, this.status);
            }
        });
    }

    startHeartbeat({delay=undefined, statusCB=undefined}) {
        if (delay) {
            debug("HTTP Starting Heartbeat")
            this.HTTPheartbeatTimer = setInterval(() => {
                this.updateStatus((err, res)=>{ // Pings server and sets status
                    if (statusCB) statusCB(this); // repeatedly call callback if supplies
                }, (unusedErr, unusedRes)=>{}); // Dont wait for status to complete
            }, delay);
        }
    }
    stopHeartbeat() {
        if (this.HTTPheartbeatTimer) {
            debug("HTTP stopping heartbeat");
            clearInterval(this.HTTPheartbeatTimer);}
    }
    stop(refreshstatus, cb) {
        this.stopHeartbeat();
        this.status = Transport.STATUS_FAILED;
        if (refreshstatus) { refreshstatus(this); }
        cb(null, this);
    }

    _cmdurl(command) {
        return  `${this.urlbase}/${command}`
    }
    _url(url, command, parmstr) {
        if (!url) throw new errors.CodingError(`${command}: requires url`);
        if (typeof url !== "string") { url = url.href }
        url = url.replace('contenthash:/contenthash', this._cmdurl(command)) ;   // Note leaves http: and https: urls unchanged
        url = url.replace('getall/table', command);
        url = url + (parmstr ? "?"+parmstr : "");
        return url;
    }

    validFor(url, func, opts) {
        // Overrides Transport.prototype.validFor because HTTP's connection test is only really for dweb.me
        // in particular this allows urls like https://be-api.us.archive.org
        return (this.connected() || (url.protocol.startsWith("http") && ! url.href.startsWith(this.urlbase))) && this.supports(url, func, opts);
    }
    // noinspection JSCheckFunctionSignatures
    async p_rawfetch(url, opts={}) {
        /*
        Fetch from underlying transport,
        Fetch is used both for contenthash requests and table as when passed to SmartDict.p_fetch may not know what we have
        url: Of resource - which is turned into the HTTP url in p_httpfetch
        opts: {start, end, retries, noCache} see p_GET for documentation
        throws: TransportError if fails
         */
        //if (!(url && url.includes(':') ))
        //    throw new errors.CodingError("TransportHTTP.p_rawfetch bad url: "+url);
        //if (url.href.includes('contenthash//'))
        //    console.error("XXX@91", url)
        if (((typeof url === "string") ? url : url.href).includes('/getall/table')) {
            throw new Error("Probably dont want to be calling p_rawfetch on a KeyValueTable, especially since dont know if its keyvaluetable or subclass"); //TODO-NAMING
        } else {
            return await httptools.p_GET(this._url(url, servercommands.rawfetch), opts);
        }
    }

    p_rawlist(url) {
        // obj being loaded
        // Locate and return a block, based on its url
        if (!url) throw new errors.CodingError("TransportHTTP.p_rawlist: requires url");
        return httptools.p_GET(this._url(url, servercommands.rawlist));
    }
    rawreverse() { throw new errors.ToBeImplementedError("Undefined function TransportHTTP.rawreverse"); }

    async p_rawstore(data) {
        /*
        Store data on http server,
        data:   string
        resolves to: {string}: url
        throws: TransportError on failure in p_POST > p_httpfetch
         */
        //PY: res = self._sendGetPost(True, "rawstore", headers={"Content-Type": "application/octet-stream"}, urlargs=[], data=data)
        console.assert(data, "TransportHttp.p_rawstore: requires data");
        const res = await httptools.p_POST(this._cmdurl(servercommands.rawstore), {data, contenttype: "application/octet-stream"}); // resolves to URL
        let parsedurl = Url.parse(res);
        let pathparts = parsedurl.pathname.split('/');
        return `contenthash:/contenthash/${pathparts.slice(-1)}`

    }

    p_rawadd(url, sig) {
        // Logged by Transports
        if (!url || !sig) throw new errors.CodingError("TransportHTTP.p_rawadd: invalid parms", url, sig);
        const data = canonicaljson.stringify(sig.preflight(Object.assign({},sig)))+"\n";
        return httptools.p_POST(this._url(url, servercommands.rawadd), {data, contenttype: "application/json"}); // Returns immediately
    }

    p_newlisturls(cl) {
        let  u = cl._publicurls.map(urlstr => Url.parse(urlstr))
            .find(parsedurl =>
                ((parsedurl.protocol === "https:" && ["gateway.dweb.me", "dweb.me"].includes(parsedurl.host)
                    && (parsedurl.pathname.includes('/content/rawfetch') || parsedurl.pathname.includes('/contenthash/')))
                    || (parsedurl.protocol === "contenthash:") && (parsedurl.pathname.split('/')[1] === "contenthash")));
        if (!u) {
            // noinspection JSUnresolvedVariable
            u = `contenthash:/contenthash/${ cl.keypair.verifyexportmultihashsha256_58() }`; // Pretty random, but means same test will generate same list and server is expecting base58 of a hash
        }
        return [u,u];
    }

    // ============================== Stream support

    /*
      Code disabled until have a chance to test it with <VIDEO> tag etc, problem is that it returns p_createReadStream whch is async
      if need sync, look at WebTorrent and how it buffers through a stream which can be returned immediately
     */
    async p_f_createReadStream(url, {wanturl=false}={}) {
        /*
        Fetch bytes progressively, using a node.js readable stream, based on a url of the form:
        No assumption is made about the data in terms of size or structure.

        This is the initialisation step, which returns a function suitable for <VIDEO>

        Returns a new Promise that resolves to function for a node.js readable stream.

        Node.js readable stream docs: https://nodejs.org/api/stream.html#stream_readable_streams

        :param string url: URL of object being retrieved of form  magnet:xyzabc/path/to/file  (Where xyzabc is the typical magnet uri contents)
        :param boolean wanturl True if want the URL of the stream (for service workers)
        :resolves to: f({start, end}) => stream (The readable stream.)
        :throws:        TransportError if url invalid - note this happens immediately, not as a catch in the promise
         */
        //Logged by Transports
        //debug("p_f_createreadstream %s", Url.parse(url).href);
        try {
            let self = this;
            if (wanturl) {
                return url;
            } else {
                return function (opts) { return self.createReadStream(url, opts); };
            }
        } catch(err) {
            //Logged by Transports
            //console.warn(`p_f_createReadStream failed on ${Url.parse(url).href} ${err.message}`);
            throw(err);
        }
    }

    createReadStream(url, opts) {
        /*
        The function, encapsulated and inside another function by p_f_createReadStream (see docs)
        NOTE THIS DOESNT WONT WORK FOR <VIDEO> tags, but shouldnt be using it there anyway - reports stream.on an filestream.pipe aren't functions

        :param file:    Webtorrent "file" as returned by webtorrentfindfile
        :param opts: { start: byte to start from; end: optional end byte }
        :returns stream: The readable stream - it is returned immediately, though won't be sending data until the http completes
         */
        // This breaks in browsers ... as 's' doesn't have .pipe but has .pipeTo and .pipeThrough neither of which work with stream.PassThrough
        // TODO See https://github.com/nodejs/readable-stream/issues/406 in case its fixed in which case enable createReadStream in constructor above.
        debug("createreadstream %s %o", Url.parse(url).href, opts);
        let through;
        through = new stream.PassThrough();
        httptools.p_GET(this._url(url, servercommands.rawfetch), Object.assign({wantstream: true}, opts))
            .then(s => s.pipe(through))
            // Note any .catch is happening AFTER through returned
            .catch(err => {
                console.warn(this.name, "createReadStream caught error", err.message);
                if (typeof through.destroy === 'function') {
                    through.destroy(err); // Will emit error & close and free up resources
                    // caller MUST implimit through.on('error', err=>) or will generate uncaught error message
                } else {
                    through.emit('error', err);
                }
            });
        return through; // Returns "through" synchronously, before the pipe is setup
    }

    async p_createReadStream(url, opts) {
        /*
        The function, encapsulated and inside another function by p_f_createReadStream (see docs)
        NOTE THIS PROBABLY WONT WORK FOR <VIDEO> tags, but shouldnt be using it there anyway

        :param file:    Webtorrent "file" as returned by webtorrentfindfile
        :param opts: { start: byte to start from; end: optional end byte }
        :resolves to stream: The readable stream.
         */
        debug("createreadstream %s %o", Url.parse(url).href, opts);
        try {
            return await httptools.p_GET(this._url(url, servercommands.rawfetch), Object.assign({wantstream: true}, opts));
        } catch(err) {
            console.warn(this.name, "caught error", err);
            throw err;
        }
    }


    // ============================== Key Value support


    // Support for Key-Value pairs as per
    // https://docs.google.com/document/d/1yfmLRqKPxKwB939wIy9sSaa7GKOzM5PrCZ4W1jRGW6M/edit#
    async p_newdatabase(pubkey) {
        //if (pubkey instanceof Dweb.PublicPrivate)
        if (pubkey.hasOwnProperty("keypair"))
            pubkey = pubkey.keypair.signingexport();
        // By this point pubkey should be an export of a public key of form xyz:abc where xyz
        // specifies the type of public key (NACL VERIFY being the only kind we expect currently)
        let u =  `${this.urlbase}/getall/table/${encodeURIComponent(pubkey)}`;
        return {"publicurl": u, "privateurl": u};
    }


    async p_newtable(pubkey, table) {
        if (!pubkey) throw new errors.CodingError("p_newtable currently requires a pubkey");
        let database = await this.p_newdatabase(pubkey);
        // If have use cases without a database, then call p_newdatabase first
        return { privateurl: `${database.privateurl}/${table}`,  publicurl: `${database.publicurl}/${table}`}  // No action required to create it
    }

    //TODO-KEYVALUE needs signing with private key of list
    async p_set(url, keyvalues, value) {  // url = yjs:/yjs/database/table/key
        if (!url || !keyvalues) throw new errors.CodingError("TransportHTTP.p_set: invalid parms", url, keyvalyes);
        // Logged by Transports
        //debug("p_set %o %o %o", url, keyvalues, value);
        if (typeof keyvalues === "string") {
            let data = canonicaljson.stringify([{key: keyvalues, value: value}]);
            await httptools.p_POST(this._url(url, servercommands.set), {data, contenttype: "application/json"}); // Returns immediately
        } else {
            let data = canonicaljson.stringify(Object.keys(keyvalues).map((k) => ({"key": k, "value": keyvalues[k]})));
            await httptools.p_POST(this._url(url, servercommands.set), {data, contenttype: "application/json"}); // Returns immediately
        }
    }

    _keyparm(key) {
        return `key=${encodeURIComponent(key)}`
    }
    async p_get(url, keys) {
        if (!url && keys) throw new errors.CodingError("TransportHTTP.p_get: requires url and at least one key");
        let parmstr =Array.isArray(keys)  ?  keys.map(k => this._keyparm(k)).join('&') : this._keyparm(keys);
        const res = await httptools.p_GET(this._url(url, servercommands.get, parmstr));
        return Array.isArray(keys) ? res : res[keys]
    }

    async p_delete(url, keys) {
        if (!url && keys) throw new errors.CodingError("TransportHTTP.p_get: requires url and at least one key");
        let parmstr =  keys.map(k => this._keyparm(k)).join('&');
        await httptools.p_GET(this._url(url, servercommands.delete, parmstr));
    }

    async p_keys(url) {
        if (!url && keys) throw new errors.CodingError("TransportHTTP.p_get: requires url and at least one key");
        return await httptools.p_GET(this._url(url, servercommands.keys));
    }
    async p_getall(url) {
        if (!url && keys) throw new errors.CodingError("TransportHTTP.p_get: requires url and at least one key");
        return await httptools.p_GET(this._url(url, servercommands.getall));
    }
    /* Make sure doesnt shadow regular p_rawfetch
    async p_rawfetch(url) {
        return {
            table: "keyvaluetable",
            _map: await this.p_getall(url)
        };   // Data structure is ok as SmartDict.p_fetch will pass to KVT constructor
    }
    */

    async p_info() { //TODO-API
        /*
        Return (via cb or promise) a numeric code for the status of a transport.
         */
        return new Promise((resolve, reject) => { try { this.updateInfo((err, res) => { if (err) {reject(err)} else {resolve(res)} })} catch(err) {reject(err)}}) // Promisify pattern v2b (no CB)
    }

    updateInfo(cb) {
        httptools.p_GET(`${this.urlbase}/info`, {retries: 1}, cb);   // Try info, but dont retry (usually heartbeat will reconnect)
    }

    static async p_test(opts={}) {
        {console.log("TransportHTTP.test")}
        try {
            let transport = await this.p_setup(opts);
            console.log("HTTP connected");
            let res = await transport.p_info();
            console.log("TransportHTTP info=",res);
            res = await transport.p_status();
            console.assert(res === Transport.STATUS_CONNECTED);
            await transport.p_test_kvt("NACL%20VERIFY");
        } catch(err) {
            console.log("Exception thrown in TransportHTTP.test:", err.message);
            throw err;
        }
    }

    static async test() {
        return this;
    }

}
Transports._transportclasses["HTTP"] = TransportHTTP;
TransportHTTP.requires = TransportHTTP.scripts = []; // Nothing to load
exports = module.exports = TransportHTTP;

