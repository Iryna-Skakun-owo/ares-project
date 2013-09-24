/*jshint node: true, strict: false, globalstrict: false */

var fs = require("graceful-fs"),
    path = require("path"),
    express = require("express"),
    util  = require("util"),
    createDomain = require('domain').create,
    log = require('npmlog'),
    temp = require("temp"),
    http = require("http"),
    async = require("async"),
    mkdirp = require("mkdirp"),
    rimraf = require("rimraf"),
    FormData = require('form-data'),
    CombinedStream = require('combined-stream'),
    base64stream = require('base64stream'),
    HttpError = require("./httpError");

module.exports = ServiceBase;

/**
 * Base object for Ares services
 * 
 * @param {Object} config
 * @property config {String} port requested IP port (0 for dynamic allocation, the default)
 * @property config {String} pathname location after the service origin, defaults to '/'
 * @property config {String} basename child class name (for tracing)
 * @property config {Boolean} performCleanup clean temporary files & folders (default to true)
 * 
 * @param {Function} next
 * @param next {Error} err
 * @param next {Object} service
 * @property service {String} protocol is 'http' or 'https'
 * @property service {String} host IP address to 
 * @property service {String} port bound port (useful in case of dynamic allocation)
 * @property service {String} origin consolidated string of protocol, host & port
 * @property service {String} pathname to locat the service behind the origin
 * 
 * @public
 */
function ServiceBase(config, next) {

	config.port = config.port || 0;
	config.pathname = config.pathname || '/';
	if (config.performCleanup === undefined) {
		config.performCleanup = true;
	}

	this.config = config;
	log.info('ServiceBase()', "config:", this.config);

	// express 3.x: app is not a server
	this.app = express();
	this.server = http.createServer(this.app);

	/*
	 * Middleware -- applied to every verbs
	 */
	if (log.level !== 'error' && log.level !== 'warn') {
		this.app.use(express.logger('dev'));
	}

	/*
	 * Error Handling - Wrap exceptions in delayed handlers
	 */
	this.app.use(function _useDomain(req, res, next) {
		log.silly("ServiceBase#_useDomain()");
		var domain = createDomain();

		domain.on('error', function(err) {
			setImmediate(next, err);
			domain.dispose();
		});

		domain.enter();
		setImmediate(next);
	});

	// CORS -- Cross-Origin Resources Sharing
	this.app.use(function _useCors(req, res, next) {
		log.silly("ServiceBase#_useCors()");
		res.header('Access-Control-Allow-Origin', "*"); // XXX be safer than '*'
		res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
		res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control');
		if ('OPTIONS' == req.method) {
			res.status(200).end();
		}
		else {
			setImmediate(next);
		}
	});

	// Authentication
	this.app.use(function(req, res, next) {
		if (req.connection.remoteAddress !== "127.0.0.1") {
			setImmediate(next, new Error("Access denied from IP address "+req.connection.remoteAddress));
		} else {
			setImmediate(next);
		}
	});

	this.use();

	// Built-in express form parser: handles:
	// - 'application/json' => req.body
	// - 'application/x-www-form-urlencoded' => req.body
	// - 'multipart/form-data' => req.body.<field>[], req.body.file[]
	this.uploadDir = temp.path({prefix: 'com.enyojs.ares.services.' + this.config.basename}) + '.d';
	fs.mkdirSync(this.uploadDir);
	this.app.use(express.bodyParser({/*maxFields: 10000,*/ keepExtensions: true, uploadDir: this.uploadDir}));

	/*
	 * verbs
	 */
	this.app.post('/config', (function(req, res /*, next*/) {
		this.configure(req.body && req.body.config, function(/*err*/) {
			res.status(200).end();
		});
	}).bind(this));

	this.route();

	/*
	 * error handling: express-3.x: middleware with arity === 4 is
	 * detected as the global error handler
	 */
	this.app.use(this.errorHandler.bind(this));

	// Send back the service location information (origin,
	// protocol, host, port, pathname) to the creator, when port
	// is bound
	this.server.listen(config.port, "127.0.0.1", null /*backlog*/, (function() {
		var tcpAddr = this.server.address();
		setImmediate(next, null, {
			protocol: 'http',
			host: tcpAddr.address,
			port: tcpAddr.port,
			origin: "http://" + tcpAddr.address + ":"+ tcpAddr.port,
			pathname: config.pathname
		});
	}).bind(this));
}

/**
 * Make sane Express matching paths
 * @protected
 */
ServiceBase.prototype.makeExpressRoute = function(path) {
	return (this.config.pathname + path)
		.replace(/\/+/g, "/") // compact "//" into "/"
		.replace(/(\.\.)+/g, ""); // remove ".."
};

/**
 * @param {Object} config
 * @propery config {} basename
 * @propery config {String} pathname
 * @propery config {String} pathname
 * @propery config {int} port
 * @protected
 */
ServiceBase.prototype.configure = function(config, next) {
	log.silly("ServiceBase#configure()", "old config:", this.config);
	log.silly("ServiceBase#configure()", "inc config:", config);
	util._extend(this.config, config);
	log.verbose("ServiceBase#configure()", "new config:", this.config);
	setImmediate(next);
};

/**
 * Additionnal middlewares: 'this.app.use(xxx)'
 * @protected
 */
ServiceBase.prototype.use = function(/*config, next*/) {
	log.verbose('ServiceBase#use()', "skipping..."); 
};

/**
 * Additionnal routes/verbs: 'this.app.get()', 'this.app.post()'
 * @protected
 */
ServiceBase.prototype.route = function(/*config, next*/) {
	log.verbose('ServiceBase#route()', "skipping..."); 
};

/**
 * @protected
 */
ServiceBase.prototype.setCookie = function(res, key, value) {
	var exdate=new Date();
	exdate.setDate(exdate.getDate() + 10 /*days*/);
	var cookieOptions = {
		domain: '127.0.0.1:' + this.config.port,
		path: this.config.pathname,
		httpOnly: true,
		expires: exdate
		//maxAge: 1000*3600 // 1 hour
	};
	res.cookie(key, value, cookieOptions);
	log.info('ServiceBase#setCookie()', "Set-Cookie: " + key + ":", value || "");
};

/**
 * Global error handler (arity === 4)
 * @protected
 */
ServiceBase.prototype.errorHandler = function(err, req, res, next){
	log.error("ServiceBase#errorHandler()", err.stack);
	res.status(err.statusCode || 500);
	res.contentType('txt'); // direct usage of 'text/plain' does not work
	res.send(err.toString());
	this.cleanSession(req, res, next);
};

/**
 * @protected
 */
ServiceBase.prototype.cleanSession = function(req, res, next) {
	log.verbose("ServiceBase#cleanSession()", 'nothing to do');
};

/**
 * @protected
 */
ServiceBase.prototype.answerOk = function(req, res /*, next*/) {
	log.verbose("ServiceBase#answerOk()", '200 OK');
	res.status(200).send();
};

/**
 * @protected
 */
ServiceBase.prototype.store = function(req, res, next) {
	if (!req.is('multipart/form-data')) {
		setImmediate(next, new HttpError("Not a multipart request", 415 /*Unsupported Media Type*/));
		return;
	}
	
	if (!req.files.file) {
		setImmediate(next, new HttpError("No file found in the multipart request", 400 /*Bad Request*/));
		return;
	}
	
	async.forEachSeries(req.files.file, function(file, next) {
		var dir = path.join(req.storeDir, path.dirname(file.name));
		log.silly("ServiceBase#store()", "mkdir -p ", dir);
		mkdirp(dir, function(err) {
			log.silly("ServiceBase#store()", "mv ", file.path, " ", file.name);
			if (err) {
				setImmediate(next, err);
			} else {
				if (file.type.match(/x-encoding=base64/)) {
					fs.readFile(file.path, function(err, data) {
						if (err) {
							log.info("ServiceBase#store()", "transcoding: error" + file.path, err);
							setImmediate(next, err);
							return;
						}
						try {
							var fpath = file.path;
							delete file.path;
							fs.unlink(fpath, function(/*err*/) { /* Nothing to do */ });
							
							var filedata = new Buffer(data.toString('ascii'), 'base64');			// TODO: This works but I don't like it
							fs.writeFile(path.join(req.storeDir, file.name), filedata, function(err) {
								log.silly("ServiceBase#store()", "from base64(): Stored: ", file.name);
								setImmediate(next, err);
							});
						} catch(transcodeError) {
							log.warn("ServiceBase#store()", "transcoding error: " + file.path, transcodeError);
							setImmediate(next, err);
						}
					}.bind(this));
				} else {
					fs.rename(file.path, path.join(req.storeDir, file.name), function(err) {
						log.silly("ServiceBase#store()", "Stored: ", file.name);
						setImmediate(next, err);
					});
				}
			}
		});
	}, next);
};

/**
 * @protected
 */
ServiceBase.prototype.returnFile = function(req, res, next) {
	res.status(200).sendfile(res.file);
	delete req.file;
	setImmediate(next);
};

/**
 * @protected
 */
ServiceBase.prototype.returnBody = function(req, res, next) {
	if (res.contentType) {
		// Otherwise count on express to detect the
		// content-type
		res.header('content-type', res.contentType);
	}
	res.status(200).send(res.body);
	delete res.body;
	delete res.contentType;
	setImmediate(next);
};

/**
 * @param {Array} parts
 * @item parts {Object} part
 * @property part {String} [filename] name to put in the FormData 
 * @property part {ReadableStream} [stream] input stream to use for the bits
 * @property part {Buffer} [buffer] input buffer to use for the bits
 * @protected
 * 
 * @see http://www.w3.org/TR/html401/interact/forms.html#h-17.13.4.2
 * @see http://www.w3.org/Protocols/rfc1341/5_Content-Transfer-Encoding.html
 */
ServiceBase.prototype.returnFormData = function(parts, res, next) {
	if (!Array.isArray(parts) || parts.length < 1) {
		setImmediate(next, new Error("Invalid parameters: cannot return a multipart/form-data of nothing"));
		return;
	}
	log.verbose("ServiceBase#returnFormData()", parts.length, "parts");
	log.silly("ServiceBase#returnFormData()", "parts", util.inspect(parts, {depth: 2}));

	var form = new FormData();
	parts.forEach(function(part) {
		if (part.buffer) {
			form.append(part.filename, part.buffer);
		} else if (part.path) {
			form.append(part.filename, fs.createReadStream(part.path));
		} else if (part.stream) {
			form.append(part.filename, part.stream);
		}
	});
	res.status(200);
	var headers = form.getHeaders();
	console.log("headers:", headers);
	Object.keys(headers).forEach(function(header) {
		res.header(header, headers[header]);
	});
	// XXX not sure why the browser cannot use 'content-type' directly...
	res.header('x-content-type', headers['content-type']);
	form.pipe(res);
	form.on('end', function() {
		log.silly("ServiceBase#returnFormData()", "Streaming completed");
		next();
	});
};

/**
 * Terminates express server & clean-up the plate
 * @protected
 */
ServiceBase.prototype.quit = function(next) {
	this.app.close();
	rimraf(this.uploadDir, next);
	log.info('ServiceBase#quit()',  "exiting");
};

/**
 * @protected
 */
ServiceBase.prototype.onExit = function() {
	rimraf(this.uploadDir, function(/*err*/) {
		// Nothing to do
	});
};
