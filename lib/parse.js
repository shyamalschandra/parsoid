/** @module */

'use strict';

require('../core-upgrade.js');

var util = require('util');

var ParserEnv = require('./config/MWParserEnvironment.js').MWParserEnvironment;
var ParsoidConfig = require('./config/ParsoidConfig.js').ParsoidConfig;
var TemplateRequest = require('./mw/ApiRequest.js').TemplateRequest;
var DU = require('./utils/DOMUtils.js').DOMUtils;
var Promise = require('./utils/promise.js');

var _wt2html, _html2wt;

/**
 * Transform wikitext to html
 *
 * @param {Object} obj See below
 * @param {MWParserEnvironment} env
 * @param {String} wt
 *
 * @return {Promise} Assuming we're ending at html
 *   @return {String} return.html
 *   @return {Array} return.lint The lint buffer
 *   @return {String} return.contentmodel
 *   @return {Object} [return.pb] If pageBundle was requested
 */
_wt2html = Promise.async(function *(obj, env, wt) {
	// `wt` will be `undefined` when we fetched page source and info,
	// which we don't want to overwrite.
	if (wt !== undefined) {
		env.setPageSrcInfo(wt);
	}
	var handler = env.getContentHandler(obj.contentmodel);
	var doc = yield handler.toHTML(env);
	var out;
	if (env.pageBundle) {
		out = DU.extractDpAndSerialize(obj.body_only ? doc.body : doc, {
			innerXML: obj.body_only,
		});
	} else {
		out = {
			html: DU.toXML(obj.body_only ? doc.body : doc, {
				innerXML: obj.body_only,
			}),
		};
	}

	if (env.conf.parsoid.linting) {
		out.lint = env.lintLogger.buffer;
		yield env.log("end/parse"); // wait for linter logging to complete
	}
	out.contentmodel = (obj.contentmodel || env.page.getContentModel());
	return out;
});

/**
 * Transform html to wikitext
 *
 * @param {Object} obj See below
 * @param {MWParserEnvironment} env
 * @param {String} html
 * @param {Object} pb
 *
 * @return {Promise} Assuming we're ending at wt
 *   @return {String} return.wt
 */
_html2wt = Promise.async(function *(obj, env, html, pb) {
	var useSelser = (obj.selser !== undefined);
	var doc = DU.parseHTML(html);
	pb = pb || DU.extractPageBundle(doc);
	if (useSelser && env.page.dom) {
		pb = pb || DU.extractPageBundle(env.page.dom.ownerDocument);
		if (pb) {
			DU.applyPageBundle(env.page.dom.ownerDocument, pb);
		}
	}
	if (pb) {
		DU.applyPageBundle(doc, pb);
	}
	var handler = env.getContentHandler(obj.contentmodel);
	var out = yield handler.fromHTML(env, doc.body, useSelser);
	return { wt: out };
});

/**
 * Map of JSON.stringified parsoidOptions to ParsoidConfig
 */
var configCache = new Map();

/**
 * Parse wikitext (or html) to html (or wikitext).
 *
 * @param {Object} obj
 * @param {String} obj.input The string to parse
 * @param {String} obj.mode The mode to use
 * @param {Object} obj.parsoidOptions Will be Object.assign'ed to ParsoidConfig
 * @param {Object} obj.envOptions Will be Object.assign'ed to the env
 * @param {Boolean} [obj.cacheConfig] Cache the constructed ParsoidConfig
 * @param {Boolean} [obj.body_only] Only return the <body> children (T181657)
 * @param {Number} [obj.oldid]
 * @param {Object} [obj.selser]
 * @param {Object} [obj.pb]
 * @param {String} [obj.contentmodel]
 * @param {String} [obj.contentVersion]
 * @param {Object} [obj.reuseExpansions]
 * @param {Function} [cb] Optional node-style callback
 *
 * @return {Promise}
 */
module.exports = Promise.async(function *(obj) {
	var start = Date.now();

	// Enforce the contraints of passing to a worker
	obj = JSON.parse(JSON.stringify(obj));

	var hash = JSON.stringify(obj.parsoidOptions);
	var parsoidConfig;
	if (obj.cacheConfig && configCache.has(hash)) {
		parsoidConfig = configCache.get(hash);
	} else {
		parsoidConfig = new ParsoidConfig(null, obj.parsoidOptions);
		if (obj.cacheConfig) {
			configCache.set(hash, parsoidConfig);
			// At present, we don't envision using the cache with multiple
			// configurations.  Prevent it from growing unbounded inadvertently.
			console.assert(configCache.size === 1, 'Config properties changed.');
		}
	}

	var env = yield ParserEnv.getParserEnv(parsoidConfig, obj.envOptions);
	env.startTime = start;
	var s1 = Date.now();
	env.bumpTimeUse("Setup Environment", s1 - start);
	env.log('info', 'started ' + obj.mode);
	try {

		if (obj.oldid) {
			env.page.meta.revision.revid = obj.oldid;
		}

		var out;
		if (['html2wt', 'html2html', 'selser'].includes(obj.mode)) {
			// Selser
			var selser = obj.selser;
			if (selser !== undefined) {
				if (selser.oldtext !== null) {
					env.setPageSrcInfo(selser.oldtext);
				}
				if (selser.oldhtml) {
					env.page.dom = DU.parseHTML(selser.oldhtml).body;
				}
				if (selser.domdiff) {
					// FIXME: need to load diff markers from attributes
					env.page.domdiff = {
						isEmpty: false,
						dom: DU.ppToDOM(selser.domdiff),
					};
					throw new Error('this is broken');
				}
			}
			var html = obj.input;
			env.bumpSerializerResourceUse('htmlSize', html.length);
			out = yield _html2wt(obj, env, html, obj.pb);
			return obj.mode === 'html2html' ? _wt2html(obj, env, out.wt) : out;
		} else { /* wt2html, wt2wt */
			// The content version to output
			if (obj.contentVersion) {
				env.setContentVersion(obj.contentVersion);
			}

			if (obj.reuseExpansions) {
				env.cacheReusableExpansions(obj.reuseExpansions);
			}

			var wt = obj.input;
			if (wt === undefined) {
				var target = env.normalizeAndResolvePageTitle();
				yield TemplateRequest.setPageSrcInfo(env, target, obj.oldid);
				env.bumpTimeUse("Pre-parse (source fetch)", Date.now() - s1);
				env.bumpParserResourceUse('wikitextSize', env.page.src.length);
			} else {
				env.bumpParserResourceUse('wikitextSize', wt.length);
			}
			out = yield _wt2html(obj, env, wt);
			return obj.mode === 'wt2html' ? out : _html2wt(obj, env, out.html);
		}
	} finally {
		var end = Date.now() - start;
		yield env.log('info', util.format('completed %s in %sms', obj.mode, end));
	}
}, 1);
