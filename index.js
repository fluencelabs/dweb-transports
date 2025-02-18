// Order is significant as should search earlier ones first
// put IPFS before Webtorrent for showcasing, as Webtorrent works in some cases IPFS doesnt so that way we exercise both
const DwebTransports = require("./Transports.js");
// SEE-OTHER-ADDTRANSPORT
require("./TransportHTTP.js");   // Can access via window.DwebTransports._transportclasses["HTTP"]
require("./TransportIPFS.js");
require("./TransportYJS.js");
require("./TransportWEBTORRENT.js");
require("./TransportWOLK.js");
require("./TransportGUN.js");
require("./TransportFluence.js");
if (typeof window !== "undefined") { window.DwebTransports = DwebTransports; }
exports = module.exports = DwebTransports;
