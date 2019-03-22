'use strict'

var os = require('os')
var fs = require('fs')
var ncp = require('ncp')
var del = require('del')
var path = require('path')
var semver = require('semver')
var request = require('request')
var exec = require('child_process').exec
var spawn = require('child_process').spawn

var platform = process.platform
if (/^win/.test(platform)) {
  platform = 'win' + (process.arch === 'ia32' ? '32' : '64')
} else if (/^darwin/.test(platform)) {
  platform = 'mac64'
} else {
  platform = 'linux' + (process.arch === 'ia32' ? '32' : '64')
}

/**
 * Creates new instance of updater. Manifest could be a `package.json` of project.
 *
 * Note that compressed apps are assumed to be downloaded in the format produced by [node-webkit-builder](https://github.com/mllrsohn/node-webkit-builder) (or [grunt-node-webkit-builder](https://github.com/mllrsohn/grunt-node-webkit-builder)).
 *
 * @constructor
 * @param {object} manifest - See the [manifest schema](#manifest-schema) below.
 * @param {object} options - Optional
 * @property {string} options.temporaryDirectory - (Optional) path to a directory to download the updates to and unpack them in. Defaults to [`os.tmpdir()`](https://nodejs.org/api/os.html#os_os_tmpdir)
 */
function updater (manifest, options) {
  this.manifest = manifest
  this.options = {
    temporaryDirectory: (options && options.temporaryDirectory) || os.tmpdir()
  }
}

/**
 * Will check the latest available version of the application by requesting the manifest specified in `manifestUrl`.
 *
 * The callback will always be called; the second parameter indicates whether or not there's a newer version.
 * This function assumes you use [Semantic Versioning](http://semver.org) and enforces it; if your local version is `0.2.0` and the remote one is `0.1.23456` then the callback will be called with `false` as the second paramter. If on the off chance you don't use semantic versioning, you could manually download the remote manifest and call `download` if you're happy that the remote version is newer.
 *
 * @param {function} cb - Callback arguments: error, newerVersionExists (`Boolean`), remoteManifest
 */
updater.prototype.checkNewVersion = function (cb) {
  /**
   * @private
   */
  function gotManifest (err, req, data) {
    if (err) {
      return cb(err)
    }
    if (req.statusCode < 200 || req.statusCode > 299) {
      return cb(new Error(req.statusCode))
    }
    try {
      data = JSON.parse(data)
    } catch (e) {
      return cb(e)
    }
    cb(null, semver.gt(data.version, this.manifest.version), data)
  }
  request.get(this.manifest.manifestUrl, gotManifest.bind(this))
}

/**
 * Downloads the new app to a temporal folder
 * @param  {Function} cb - called when download completes. Callback arguments: error, downloaded filepath
 * @param  {Object} newManifest - see [manifest schema](#manifest-schema) below
 * @return {Request} Request - stream, the stream contains `manifest` property with new manifest and 'content-length' property with the size of package.
 */
updater.prototype.download = function (cb, newManifest) {
  var manifest = newManifest || this.manifest
  var url = manifest.packages[platform].url
  var pkg = request(url, function (err, response) {
    if (err) {
      cb(err)
    }
    if (response && (response.statusCode < 200 || response.statusCode >= 300)) {
      pkg.abort()
      return cb(new Error(response.statusCode))
    }
  })
  pkg.on('response', function (response) {
    if (response && response.headers && response.headers['content-length']) {
      pkg['content-length'] = response.headers['content-length']
    }
  })
  var filename = path.basename(url)
  var destinationPath = path.join(this.options.temporaryDirectory, filename)
  fs.unlink(path.join(this.options.temporaryDirectory, filename), function () {
    pkg.pipe(fs.createWriteStream(destinationPath))
    pkg.resume()
  })
  pkg.on('error', cb)
  pkg.on('end', function () {
    process.nextTick(function () {
      if (pkg.response.statusCode >= 200 && pkg.response.statusCode < 300) {
        cb(null, destinationPath)
      }
    })
  })
  pkg.pause()
  return pkg
}

/**
 * Returns executed application path
 * @returns {string}
 */
updater.prototype.getAppPath = function () {
  var appPath = {
    mac: path.join(process.cwd(), '../../..'),
    win: path.dirname(process.execPath)
  }
  appPath.win32 = appPath.win
  appPath.win64 = appPath.win
  appPath.mac32 = appPath.mac
  appPath.mac64 = appPath.mac
  appPath.linux32 = appPath.win
  appPath.linux64 = appPath.win
  return appPath[platform]
}

/**
 * Returns current application executable
 * @returns {string}
 */
updater.prototype.getAppExec = function () {
  var execFolder = this.getAppPath()
  var exec = {
    mac: '',
    win: path.basename(process.execPath)
  }
  exec.mac32 = exec.mac
  exec.mac64 = exec.mac
  exec.win32 = exec.win
  exec.win64 = exec.win
  exec.linux32 = exec.win
  exec.linux64 = exec.win
  return path.join(execFolder, exec[platform])
}

/**
 * Will unpack the `filename` in temporary folder.
 * For Windows, [unzip](https://www.mkssoftware.com/docs/man1/unzip.1.asp) is used (which is [not signed](https://github.com/edjafarov/node-webkit-updater/issues/68)).
 *
 * @param {string} filename
 * @param {function} cb - Callback arguments: error, unpacked directory
 * @param {object} manifest
 */
updater.prototype.unpack = function (filename, cb, manifest) {
  pUnpack[platform](filename, cb, manifest, this.options.temporaryDirectory)
}

/**
 * @private
 * @param {string} zipPath
 * @param {string} temporaryDirectory
 * @return {string}
 */
var getZipDestinationDirectory = function (zipPath, temporaryDirectory) {
  return path.join(temporaryDirectory, path.basename(zipPath, path.extname(zipPath)))
}
/**
 * @private
 * @param {object} manifest
 * @return {string}
 */
var getExecPathRelativeToPackage = function (manifest) {
  var execPath = manifest.packages[platform] && manifest.packages[platform].execPath
  if (execPath) {
    return execPath
  } else {
    var suffix = {
      win: '.exe',
      mac: '.app'
    }
    suffix.mac32 = suffix.mac
    suffix.mac64 = suffix.mac
    suffix.win32 = suffix.win
    suffix.win64 = suffix.win
    return manifest.name + (suffix[platform] || '')
  }
}

var pUnpack = {
  /**
   * @private
   */
  mac: function (filename, cb, manifest, temporaryDirectory) {
    var extension = path.extname(filename)
    var destination = path.join(temporaryDirectory, path.basename(filename, extension))
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(destination)
    }
    exec('unzip -xoqq "' + filename + '" > /dev/null', { cwd: destination }, function (err) {
      if (err) {
        console.log(err)
        return cb(err)
      }
      var appPath = path.join(destination, getExecPathRelativeToPackage(manifest))
      cb(null, appPath)
    })
  },
  /**
   * @private
   */
  win: function (filename, cb, manifest, temporaryDirectory) {
    var destinationDirectory = getZipDestinationDirectory(filename, temporaryDirectory)
    var unzip = function () {
      // unzip by C. Spieler (docs: https://www.mkssoftware.com/docs/man1/unzip.1.asp, issues: http://www.info-zip.org/)
      exec('"' + path.resolve(__dirname, 'tools/unzip.exe') + '" -u -o "' +
            filename + '" -d "' + destinationDirectory + '" > NUL', function (err) {
        if (err) {
          return cb(err)
        }

        cb(null, path.join(destinationDirectory, getExecPathRelativeToPackage(manifest)))
      })
    }
    fs.exists(destinationDirectory, function (exists) {
      if (exists) {
        del(destinationDirectory, {force: true}, function (err) {
          if (err) {
            cb(err)
          } else {
            unzip()
          }
        })
      } else {
        unzip()
      }
    })
  },
  /**
   * @private
   */
  linux: function (filename, cb, manifest, temporaryDirectory) {
    var extension = path.extname(filename)
    var destination = path.join(temporaryDirectory, path.basename(filename, extension))
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(destination)
    }
    exec('unzip -xoqq "' + filename + '" > /dev/null', { cwd: destination }, function (err) {
      if (err) {
        console.log(err)
        return cb(err)
      }
      cb(null, destination)
    })
  }
}
pUnpack.mac32 = pUnpack.mac
pUnpack.mac64 = pUnpack.mac
pUnpack.win32 = pUnpack.win
pUnpack.win64 = pUnpack.win
pUnpack.linux32 = pUnpack.linux
pUnpack.linux64 = pUnpack.linux

/**
 * Runs installer
 * @param {string} appPath
 * @param {array} args - Arguments which will be passed when running the new app
 * @param {object} options - Optional
 * @returns {function}
 */
updater.prototype.runInstaller = function (appPath, args, options) {
  return pRun[platform].apply(this, arguments)
}

var pRun = {
  /**
   * @private
   */
  mac: function (appPath, args, options) {
    if (args && args.length) {
      args = [appPath].concat('--args', args)
    } else {
      args = [appPath]
    }
    return run('open', args, options)
  },
  /**
   * @private
   */
  win: function (appPath, args, options, cb) {
    return run(appPath, args, options, cb)
  },
  /**
   * @private
   */
  linux: function (appPath, args, options, cb) {
    var appExec = manifest.name
    fs.chmodSync(appPath, '0755')
    if (!options) options = {}
    options.cwd = appPath
    return run(appExec, args, options, cb)
  }
}
pRun.mac32 = pRun.mac
pRun.mac64 = pRun.mac
pRun.win32 = pRun.win
pRun.win64 = pRun.win
pRun.linux32 = pRun.linux
pRun.linux64 = pRun.linux

/**
 * @private
 */
function run (appPath, args, options) {
  var opts = {
    detached: true
  }
  for (var key in options) {
    opts[key] = options[key]
  }
  var sp
  var parsedArgs
  if (/^darwin/.test(process.platform)) {
    opts['cwd'] = path.dirname(process.execPath)
    parsedArgs = './update.sh "' + args[0] + '" "' + args[2] + '"'
    sp = spawn('bash', ['-c', parsedArgs], opts)
    sp.unref()
  } else {
    sp = spawn(appPath, args, opts)
    sp.unref()
  }
  return sp
}

/**
 * Installs the app (copies current application to `copyPath`)
 * @param {string} copyPath
 * @param {function} cb - Callback arguments: error
 */
updater.prototype.install = function (copyPath, cb) {
  pInstall[platform].apply(this, arguments)
}

var pInstall = {
  /**
   * @private
   */
  mac: function (to, cb) {
    ncp(this.getAppPath(), to, cb)
  },
  /**
   * @private
   */
  win: function (to, cb) {
    var self = this
    var errCounter = 50
    function deleteApp (cb) {
      del(to, {force: true}, cb)
    }
    function appDeleted (err) {
      if (err) {
        errCounter--
        if (errCounter > 0) {
          setTimeout(function () {
            deleteApp(appDeleted)
          }, 100)
        } else {
          return cb(err)
        }
      } else {
        ncp(self.getAppPath(), to, appCopied)
      }
    }
    function appCopied (err) {
      if (err) {
        setTimeout(deleteApp, 100, appDeleted)
        return
      }
      cb()
    }
    deleteApp(appDeleted)
  },
  /**
   * @private
   */
  linux: function (to, cb) {
    ncp(this.getAppPath(), to, cb)
  }
}
pInstall.mac32 = pInstall.mac
pInstall.mac64 = pInstall.mac
pInstall.win32 = pInstall.win
pInstall.win64 = pInstall.win
pInstall.linux32 = pInstall.linux
pInstall.linux64 = pInstall.linux

/**
 * Runs the app from original app executable path.
 * @param {string} execPath
 * @param {array} args - Arguments passed to the app being ran.
 * @param {object} options - Optional. See `spawn` from nodejs docs.
 *
 * Note: if this doesn't work, try `gui.Shell.openItem(execPath)` (see [node-webkit Shell](https://github.com/rogerwang/node-webkit/wiki/Shell)).
 */
updater.prototype.run = function (execPath, args, options) {
  var arg = arguments
  if (platform.indexOf('linux') === 0) arg[0] = path.dirname(arg[0])
  pRun[platform].apply(this, arg)
}

module.exports = updater
