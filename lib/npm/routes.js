'use strict';

const ndjson = require('ndjson');
const async = require('async');
const etag = require('etag');

module.exports = function (app) {
  const Package = app.models.Package;
  const Version = app.models.Version;
  const auth = app.npmAuthMiddleware || ((req, res, next) => {
    next(null);
  });

  //
  // Setup our known param handlers for well-known npm
  // parameter names.
  //
  require('./params')(app.routes);

  //
  // ### unpublish
  // Unpublish a package but only when it will not have
  // an adverse affect on a build that we care about.
  //
  app.routes.delete('/:pkg/-rev/:rev', auth, function deleteNPMPackageRoute(req, res, next) {
    //
    // TODO: ensure that no builds prevent this unpublish event.
    // Remark: Should we also change the state of the package in cassandra here
    // or does that happen on a different request?
    //
    app.npmProxy(req, res, next);
  });

  //
  // ### dist-tags/
  // Atomic operations on all dist-tags.
  //
  app.routes.route('/-/package/:pkg/dist-tags')
    .get(auth, function (req, res, next) {
      app.tagger.list(req.params.pkg, function getDistTagNPMPackageRoute(err, tags) {
        if (err) { return next(err); }
        res.status(200).json(tags);
      });
    })
    .put(auth, function putDistTagNPMPackageRoute(req, res, next) {
      /*eslint no-unused-vars: 0*/

      //
      // Remark: as of npm@2.13.5 this is not consumed anywhere, but it is
      // implemented as `registry.distTags.set` in npm-registry-client. see:
      // https://github.com/npm/npm-registry-client/blob/master/lib/dist-tags/set.js.
      // We are choosing to not implement it here purposefully.
      //
      res.status(400).json({ message: 'Not implemented' });
    })
    .post(auth, function postDistTagNPMPackageRoute(req, res, next) {
      /*eslint no-unused-vars: 0*/

      //
      // Remark: as of npm@2.13.5 this is not consumed anywhere, but it is
      // implemented as `registry.distTags.set` in npm-registry-client. see:
      // https://github.com/npm/npm-registry-client/blob/master/lib/dist-tags/update.js.
      // We are choosing to not implement it here purposefully.
      //
      res.status(400).json({ message: 'Not implemented' });
    });

  //
  // ### dist-tags/:tag
  // Atomic operations on individual dist-tags.
  //
  app.routes.route('/-/package/:pkg/dist-tags/:tag')
    .delete(auth, function deleteDistTagNPMPackageRoute(req, res, next) {
      app.tagger.delete(req.params, function (err) {
        if (err) { return next(err); }
        res.status(204).end();
      });
    })
    .put(auth, tagBuild)
    .post(auth, tagBuild);

  //
  // ### View package
  // Attempts to fetch the `package` and `version`
  // records that have been persisted for this `:pkg`
  //
  app.routes.get('/:pkg', auth, function getNPMPackageRoute(req, res, done) {
    const name = req.params.pkg;
    const etags = {
      last: req.headers['if-none-match']
    };

    async.waterfall([
      Package.get.bind(Package, name),
      function getVersion(pkg, next) {
        //
        // Default to the version for the environment or the latest `distTag`.
        //
        const env = req.headers['registry-environment'] || 'test';
        const version = pkg && pkg.distTags && (pkg.distTags[env]
          || pkg.distTags.latest);

        if (!version) {
          req.log.warn('No package %s in cassandra, proxying to artifactory', name, pkg);
          //
          // Hit our final middleware
          //
          return next();
        }

        Version.get([name, version].join('@'), next);
      }
    ], function onPackageVersion(err, version) {
      if (err || !version) { return done(err); }

      let send = version.value;
      let status = 200;

      //
      // TODO: store this on the version record itself because
      // it wasteful to recalculate it every request.
      //
      etags.now = etag(version.value);
      res.setHeader('etag', etags.now);
      res.setHeader('content-type', 'applcation/json');

      if (etags.now === etags.last) {
        status = 304;
        send = '';
      }

      res.status(status);
      res.end(send);
    });
  });

  /**
   * Create a new tag for the specified package and data, also run a
   * Carpenter build async.
   *
   * @param {HTTPRequest} req Request from npm or similar client
   * @param {HTTPResponse} res Response to npm or similar client
   * @param {Function} next Completion callback.
   * @api private
   * @returns {undefined}
   */
  function tagBuild(req, res, next) {
    var version = req.body;
    app.tagger.add({
      pkg: req.params.pkg,
      tag: req.params.tag,
      version
    }, function distTagged(err, pack, tags) {
      if (err) { return next(err); }

      /**
       * Carpenter error occured.
       *
       * @param {Error} buildError Request or Carpenter error
       * @api private
       * @returns {undefined}
       */
      function error(buildError) {
        req.log.error(buildError);

        //
        // Remove the already tagged version as the build/rollback failed miserably.
        //
        app.tagger.delete(req.params, req.log.error);
      }

      //
      // Respond with the newly created tags.
      //
      res.status(201).json(tags);

      //
      // Don't wait for the build to complete as it can be longer
      // that the default request timeout, before responding with the dist-tag
      // details. In the case of any build errors remove the dist-tag.
      // Add tag as environment to package and trigger build.
      //
      pack.env = req.params.tag;

      var spec = {
        name: req.params.pkg,
        env: req.params.tag
      };

      var buildSpec = Object.assign({ version }, spec);

      function finish(err) {
        if (err) return error(err);

        req.log.info('Successful rollback to %s', version, buildSpec);
      }
      //
      // If this version already has a build associated, assume we want to
      // rollback to that version
      //
      req.log.info('Searching for build based on tag', buildSpec);
      app.bffs.search(buildSpec, function findPreviousBuild(err, build) {
        if (build) {
          req.log.info('Executing rollback, version %s found', version,  buildSpec);
          return app.bffs.rollback(spec, version, finish);
        }
        if (err) req.log.error(err);

        req.log.info('No previous build for %s, carpenter trigger', version, buildSpec);
        app.carpenter.build({ data: pack }, function response(err, buildLog) {
          if (err) { return error(err); }

          //
          // Log the streaming responses of the builder.
          // TODO: can these be streamed back to npm?
          //
          buildLog.pipe(ndjson.parse())
            .on('error', error)
            .on('data', function onData(data) {
              if (data.event === 'error') {
                return error(err);
              }

              req.log.info(data);
            });
        });
      });
    });
  }
};


