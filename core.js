const fs           = require('fs')
    , path         = require('path')
    , chalk        = require('chalk')
    , commandico   = require('commandico')
    , inherits     = require('util').inherits
    , EventEmitter = require('events').EventEmitter
    , combinedStream = require('combined-stream')
    , StringStream = require('string-to-stream')

/* jshint -W079 */
const createMenuFactory  = require('simple-terminal-menu/factory')
    , print              = require('./lib/print')
    , util               = require('./util')
    , i18n               = require('./i18n')
    , storage            = require('./lib/storage')
    , error              = require('./lib/error')
/* jshint +W079 */
  

function Core (options) {
  if (!(this instanceof Core))
    return new Core(options)

  if (!options.name)
    throw new Error('The workshopper needs a name to store the progress.');

  if (!options.languages) 
    options.languages = ['en']

  if (!options.defaultLang)
    options.defaultLang = options.languages[0]

  if (options.appDir)
    options.appDir = util.getDir(options.appDir, '.')

  if (options.appDir)
    options.exerciseDir = util.getDir(options.exerciseDir || 'exercises', options.appDir)

  if (!options.menu)
    options.menu = {
        width: 65
      , x: 3
      , y: 2
    }

  if (!options.menuFactory)
    options.menuFactory = createMenuFactory(options.menu, {})

  EventEmitter.call(this)

  this.options     = options

  var globalStorage = storage(storage.userDir, '.config', 'workshopper')
  this.appStorage   = storage(storage.userDir, '.config', options.name)

  this.exercises   = []
  this._meta       = {}

  this.i18n        = i18n.init(options, globalStorage, this.appStorage)
  this.__          = this.i18n.__
  this.__n         = this.i18n.__n

  this.cli = commandico(this, 'menu')
    .loadCommands(path.resolve(__dirname, './lib/commands'))
    .loadModifiers(path.resolve(__dirname, './lib/modifiers'))

  if (options.commands)
    this.cli.addCommands(options.commands)

  if (options.modifiers)
    this.cli.addModifiers(options.modifiers)
}

inherits(Core, EventEmitter)


Core.prototype.execute = function (args) {
  return this.cli.execute(args)
}

Core.prototype.addExercise = function (meta) {
  this.exercises.push(meta.name)
  this.i18n.updateExercises(this.exercises)
  this._meta[meta.id] = meta
  meta.number = this.exercises.length
  return this
}

Core.prototype.end = function (mode, pass, exercise, callback) {
  var end = (typeof exercise.end == 'function') ? exercise.end.bind(exercise, mode, pass) : setImmediate;
  end(function (err) {
      if (err)
        return error(this.__('error.cleanup', {err: err.message || err}))

      setImmediate(callback || function () {
        process.exit(pass ? 0 : -1)
      })
    }.bind(this))
}

// overall exercise fail
Core.prototype.exerciseFail = function (mode, exercise) {
  if (!exercise.fail) {
    exercise.fail = '\n' +
      '{bold}{red}# {solution.fail.title}{/red}{/bold}\n' +
      '{solution.fail.message}\n'
    exercise.failType = 'txt'
  }
  var stream = print(this.i18n, this.i18n.lang())
  stream.appendPlus(exercise.fail, exercise.failType).pipe(process.stdout)
  this.end(mode, false, exercise)
}

Core.prototype.countRemaining = function () {
  var completed = this.appStorage.get('completed')
  return this.exercises.length - completed ? completed.length : 0
}

Core.prototype.markCompleted = function (exerciseName) {
  var completed = this.appStorage.get('completed') || []

  if (completed.indexOf(exerciseName) === -1) 
    completed.push(exerciseName)

  this.appStorage.save('completed', completed)
}

// overall exercise pass
Core.prototype.exercisePass = function (mode, exercise) {
  var done = function done (files) {
    this.markCompleted(exercise.meta.name)

    if (!exercise.pass) {
      exercise.pass = '\n' +
        '{bold}{green}# {solution.pass.title}{/green}{/bold}\n' +
        '{bold}{solution.pass.message}{/bold}\n'
      exercise.passType = 'txt'
    }

    var stream = print(this.i18n, this.i18n.lang())
    stream.append(exercise.pass, exercise.passType)

    if (!exercise.hideSolutions) {
      if (files.length > 0 || exercise.solution)
        stream.append(this.__('solution.notes.compare'))
      
      stream.append(exercise.solution, exercise.solutionType)
      stream.append({ files: files })
    }

    var remaining = this.countRemaining()
    if (remaining !== 0)
      stream.append(
          this.__n('progress.remaining', remaining) + '\n'
        + this.__('ui.return', {appName: this.name}) + '\n'
      )
    else if (!this.onComplete)
      stream.append(this.__('progress.finished') + '\n')

    stream.pipe(process.stdout).on("end", function () {
      var complete = (this.onComplete === 'function') ? this.onComplete.bind(this) : setImmediate;
      complete(this.end.bind(this, mode, true, exercise))
    }.bind(this))

  }.bind(this)


  if (!exercise.hideSolutions && typeof exercise.getSolutionFiles === 'function') {
    exercise.getSolutionFiles(function (err, files) {
      if (err)
        return error(this.__('solution.notes.load_error', {err: err.message || err}))
      done(files)
    }.bind(this))
  } else {
    done([])
  }
}

// single 'pass' event for a validation
function onpass (msg) {
  console.log(chalk.green.bold('\u2713 ') + msg)
}


// single 'fail' event for validation
function onfail (msg) {
  console.log(chalk.red.bold('\u2717 ') + msg)
}

Core.prototype.runExercise = function (exercise, mode, args) {
  // individual validation events
  if (typeof exercise.on === 'function') {
    exercise.on('pass', onpass)
    exercise.on('fail', onfail)
    exercise.on('pass', this.emit.bind(this, 'pass', exercise, mode))
    exercise.on('fail', this.emit.bind(this, 'fail', exercise, mode)) 
  }

  function done (err, pass) {

    if (pass === undefined && (err === true || err === false || err === undefined || err === null)) {
      pass = err
      err = null
    }

    if (err) {
      // if there was an error then we need to do this after cleanup
      return this.end(mode, true, exercise, function () {
        error(this.__('error.exercise.unexpected_error', {mode: mode, err: (err.message || err) }))
      }.bind(this))
    }

    if (mode == 'run')
      return this.end(mode, true, exercise) // clean up

    if (!pass || exercise.fail)
      return this.exerciseFail(mode, exercise)

    this.exercisePass(mode, exercise)
  }

  var method = exercise[mode]
    , result;

  if (!method)
    return error('This problem doesn\'t have a .' + mode + ' function.')

  if (typeof method !== 'function')
    return error('This .' + mode + ' is a ' + typeof method + '. It should be a function instead.')

  result = (method.length > 1)
        ? method.bind(exercise)(args, done.bind(this))
        : method.bind(exercise)(args)
  
  if (result)
    print(this.i18n, this.i18n.lang()).appendPlus(result).pipe(process.stdout)
}

Core.prototype.printMenu = function () {
  var __ = this.i18n.__
    , completed = this.appStorage.get('completed') || []
    , isCommandInMenu = function (extra) {
        if (typeof extra.filter === 'function' && !extra.filter(this)) {
          return false
        } 
        return extra.menu !== false
      }.bind(this)
    , exitCommand = {
        name: 'exit',
        handler: process.exit.bind(process, 0)
      }

  this.options.menuFactory.create({
    title: this.i18n.__('title'),
    subtitle: this.i18n.has('subtitle') && this.i18n.__('subtitle'),
    menu: this.exercises.map(function (exercise) {
        return {
          label: chalk.bold('»') + ' ' + __('exercise.' + exercise),
          marker: (completed.indexOf(exercise) >= 0) ? '[' + __('menu.completed') + ']' : '',
          handler: this.printExercise.bind(this, exercise)
        };
      }.bind(this)),
    extras: this.cli.commands
      .reverse()
      .filter(isCommandInMenu)
      .concat(exitCommand)
      .map(function (command) {
        return {
          label: __('menu.' + command.name),
          handler: command.handler.bind(command, this)
        };
      }.bind(this))
    
  });
}

Core.prototype.loadExercise = function (name) {
  var meta = this._meta[util.idFromName(name)]
  
  if (!meta)
    return null

  exercise = meta.fn()

  if (typeof exercise.init === 'function')
    exercise.init(this, meta.id, meta.name, meta.dir, meta.number)
  
  exercise.meta = meta

  return exercise
}

Core.prototype.printExercise = function printExercise (name) {
  var exercise = this.loadExercise(name)
    , prepare

  if (!exercise)
    return error(this.__('error.exercise.missing', {name: name}))

  this.appStorage.save('current', exercise.meta.name)

  prepare = (typeof exercise.prepare === 'function') ? exercise.prepare.bind(exercise) : setImmediate;
  prepare(function(err) {
    if (err)
      return error(this.__('error.exercise.preparing', {err: err.message || err}))

    var getExerciseText = (typeof exercise.getExerciseText === 'function') ? exercise.getExerciseText.bind(exercise) : setImmediate;
    getExerciseText(function (err, exerciseTextType, exerciseText) {
      if (err)
        return error(this.__('error.exercise.loading', {err: err.message || err}))

      var stream = print(this.i18n.extend({
            "currentExercise.name" : exercise.meta.name
          , "progress.count" : exercise.meta.number
          , "progress.total" : this.exercises.length
          , "progress.state_resolved" : this.__('progress.state', {count: exercise.meta.number, amount: this.exercises.length})
        }), this.i18n.lang())
        , found = false
      stream.append(exercise.header, exercise.headerType)
       || stream.append({file: exercise.headerFile})
       || stream.append(this.options.header, this.options.headerType)
       || stream.append({file: this.options.headerFile})

      if (stream.append(exercise.problem, exercise.problemType))
        found = true
      if (stream.append(exerciseText, exerciseTextType))
        found = true
      if (!found)
        return error('The exercise "' + name + '" is missing a problem definition!')

      stream.append(exercise.footer, exercise.footerType)
       || stream.append({file: exercise.footerFile})
       || stream.append(this.options.footer, this.options.footerType)
       || stream.append({file: this.options.footerFile})
      stream.pipe(process.stdout)
      }.bind(this))
  }.bind(this))
}

module.exports = Core