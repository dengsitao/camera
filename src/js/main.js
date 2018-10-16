// Copyright (c) 2013 The Chromium OS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

/**
 * Namespace for the Camera app.
 */
var camera = camera || {};

/**
 * Creates the Camera App main object.
 * @param {number} aspectRatio Aspect ratio of app window when launched.
 * @constructor
 */
camera.Camera = function(aspectRatio) {
  /**
   * @type {camera.Camera.Context}
   * @private
   */
  this.context_ = new camera.Camera.Context(
      this.onAspectRatio_.bind(this),
      this.onError_.bind(this),
      this.onErrorRecovered_.bind(this),
      this.onToast_.bind(this));

  /**
   * @type {camera.Toast}
   * @private
   */
  this.toast_ = new camera.Toast();

  /**
   * @type {Array.<camera.ViewsStack>}
   * @private
   */
  this.viewsStack_ = new camera.Camera.ViewsStack();

  /**
   * @type {camera.Router}
   * @private
   */
  this.router_ = new camera.Router(
      this.navigateById_.bind(this),
      this.viewsStack_.pop.bind(this.viewsStack_));

  /**
   * @type {camera.views.Camera}
   * @private
   */
  this.cameraView_ = null;

  /**
   * @type {camera.views.Browser}
   * @private
   */
  this.browserView_ = null;

  /**
   * @type {camera.views.Dialog}
   * @private
   */
  this.dialogView_ = null;

  /**
   * @type {?number}
   * @private
   */
  this.resizeWindowTimeout_ = null;

  /**
   * @type {number}
   * @private
   */
  this.aspectRatio_ = aspectRatio;

  // End of properties. Seal the object.
  Object.seal(this);

  // Handle key presses to make the Camera app accessible via the keyboard.
  document.body.addEventListener('keydown', this.onKeyPressed_.bind(this));

  // Handle window resize.
  window.addEventListener('resize', this.onWindowResize_.bind(this, null));

  // Set the localized window title.
  document.title = chrome.i18n.getMessage('name');
};

/**
 * Creates context for the views.
 * @param {function(number)} onAspectRatio Callback when the aspect ratio is
 *     changed. Arguments: aspect ratio.
 * @param {function(string, string, string=)} onError Callback when an error
 *     occurs. Arguments: identifier, first line, second line.
 * @param {function(string)} onErrorRecovered Callback when an error goes away.
 *     Arguments: error id.
 * @param {function(string, boolean)} onToast Callback when a toast occurs.
 *     Arguments: toast message, i18n-named.
 * @constructor
 */
camera.Camera.Context = function(
    onAspectRatio, onError, onErrorRecovered, onToast) {
  camera.View.Context.call(this);

  /**
   * @type {boolean}
   */
  this.hasError = false;

  /**
   * @type {function(number)}
   */
  this.onAspectRatio = onAspectRatio;

  /**
   * @type {function(string, string, string=)}
   */
  this.onError = onError;

  /**
   * @type {function(string)}
   */
  this.onErrorRecovered = onErrorRecovered;

  /**
   * @type {function(string, boolean)}
   */
  this.onToast = onToast;

  // End of properties. Seal the object.
  Object.seal(this);
};

camera.Camera.Context.prototype = {
  __proto__: camera.View.Context.prototype
};

/**
 * Creates a stack of views.
 * @constructor
 */
camera.Camera.ViewsStack = function() {
  /**
   * Stack with the views as well as return callbacks.
   * @type {Array.<Object>}
   * @private
   */
  this.stack_ = [];

  // No more properties. Seal the object.
  Object.seal(this);
};

camera.Camera.ViewsStack.prototype = {
  get current() {
    return this.stack_.length ? this.stack_[this.stack_.length - 1].view : null;
  },
  get all() {
    return this.stack_.map(entry => entry.view);
  }
};

/**
 * Adds the view on the stack and hence makes it the current one. Optionally,
 * passes the arguments to the view.
 * @param {camera.View} view View to be pushed on top of the stack.
 * @param {Object=} opt_arguments Optional arguments.
 * @param {function(Object=)} opt_callback Optional result callback to be called
 *     when the view is closed.
 */
camera.Camera.ViewsStack.prototype.push = function(
    view, opt_arguments, opt_callback) {
  if (!view)
    return;
  if (this.current)
    this.current.inactivate();

  this.stack_.push({
    view: view,
    callback: opt_callback || function(result) {}
  });

  view.enter(opt_arguments);
  view.activate();
};

/**
 * Removes the current view from the stack and hence makes the previous one
 * the current one. Calls the callback passed to the previous view's navigate()
 * method with the result.
 * @param {Object=} opt_result Optional result. If not passed, then undefined
 *     will be passed to the callback.
 */
camera.Camera.ViewsStack.prototype.pop = function(opt_result) {
  var entry = this.stack_.pop();
  entry.view.inactivate();
  entry.view.leave();

  if (this.current)
    this.current.activate();
  if (entry.callback)
    entry.callback(opt_result);
};

/**
 * Starts the app by initializing views and showing the camera view.
 */
camera.Camera.prototype.start = function() {
  var model = new camera.models.Gallery();
  this.cameraView_ =
      new camera.views.Camera(this.context_, this.router_, model);
  this.browserView_ =
      new camera.views.Browser(this.context_, this.router_, model);
  this.dialogView_ = new camera.views.Dialog(this.context_, this.router_);

  var promptMigrate = () => {
    return new Promise((resolve, reject) => {
      this.router_.navigate(camera.Router.ViewIdentifier.DIALOG, {
        type: camera.views.Dialog.Type.ALERT,
        message: chrome.i18n.getMessage('migratePicturesMsg')
      }, result => {
        if (!result.isPositive) {
          var error = new Error('Did not acknowledge migrate-prompt.');
          error.exitApp = true;
          reject(error);
          return;
        }
        resolve();
      });
    });
  };
  camera.models.FileSystem.initialize(promptMigrate).then(() => {
    // Prepare the views and model, and then make the app ready.
    this.cameraView_.prepare();
    this.browserView_.prepare();
    model.load([this.cameraView_.galleryButton, this.browserView_]);

    camera.Tooltip.initialize();
    camera.util.makeElementsUnfocusableByMouse();
    camera.util.setupElementsAriaLabel();
    this.router_.navigate(camera.Router.ViewIdentifier.CAMERA);
  }).catch(error => {
    console.error(error);
    if (error && error.exitApp) {
      chrome.app.window.current().close();
      return;
    }
    this.onError_('filesystem-failure',
        chrome.i18n.getMessage('errorMsgFileSystemFailed'));
  });
};

/**
 * Switches the view using a router's view identifier.
 * @param {camera.Router.ViewIdentifier} viewIdentifier View identifier.
 * @param {Object=} opt_arguments Optional arguments for the view.
 * @param {function(Object=)} opt_callback Optional result callback to be called
 *     when the view is closed.
 * @private
 */
camera.Camera.prototype.navigateById_ = function(
    viewIdentifier, opt_arguments, opt_callback) {
  switch (viewIdentifier) {
    case camera.Router.ViewIdentifier.CAMERA:
      this.viewsStack_.push(this.cameraView_, opt_arguments, opt_callback);
      break;
    case camera.Router.ViewIdentifier.BROWSER:
      this.viewsStack_.push(this.browserView_, opt_arguments, opt_callback);
      break;
    case camera.Router.ViewIdentifier.DIALOG:
      this.viewsStack_.push(this.dialogView_, opt_arguments, opt_callback);
      break;
  }
};

/**
 * Resizes the window to match the last known aspect ratio if applicable.
 * @private
 */
camera.Camera.prototype.resizeByAspectRatio_ = function() {
  // Don't update window size if it's maximized or fullscreen.
  if (camera.util.isWindowFullSize()) {
    return;
  }

  // Keep the width fixed and calculate the height by the aspect ratio.
  // TODO(yuli): Update min-width for resizing at portrait orientation.
  var appWindow = chrome.app.window.current();
  var inner = appWindow.innerBounds;
  var innerW = inner.minWidth;
  var innerH = Math.round(innerW / this.aspectRatio_);

  // Limit window resizing capability by setting min-height. Don't limit
  // max-height here as it may disable maximize/fullscreen capabilities.
  // TODO(yuli): Revise if there is an alternative fix.
  inner.minHeight = innerH;

  inner.width = innerW;
  inner.height = innerH;
};

/**
 * Handles resizing window/views for size or aspect ratio changes.
 * @param {number=} aspectRatio Aspect ratio changed.
 * @private
 */
camera.Camera.prototype.onWindowResize_ = function(aspectRatio) {
  if (this.resizeWindowTimeout_) {
    clearTimeout(this.resizeWindowTimeout_);
    this.resizeWindowTimeout_ = null;
  }
  if (aspectRatio) {
    // Update window size immediately for changed aspect ratio.
    this.aspectRatio_ = aspectRatio;
    this.resizeByAspectRatio_();
  } else {
    // Don't further resize window during resizing for smooth UX.
    this.resizeWindowTimeout_ = setTimeout(() => {
      this.resizeWindowTimeout_ = null;
      this.resizeByAspectRatio_();
    }, 500);
  }

  // Resize all stacked views rather than just the current-view to avoid
  // camera-preview not being resized if a dialog or settings' menu is shown on
  // top of the camera-view.
  this.viewsStack_.all.forEach(view => {
    view.onResize();
  });
};

/**
 * Handles pressed keys.
 * @param {Event} event Key press event.
 * @private
 */
camera.Camera.prototype.onKeyPressed_ = function(event) {
  if (camera.util.getShortcutIdentifier(event) == 'BrowserBack') {
    chrome.app.window.current().minimize();
    return;
  }

  var currentView = this.viewsStack_.current;
  if (currentView && !this.context_.hasError) {
    currentView.onKeyPressed(event);
  }
};

/**
 * Updates the window apsect ratio.
 * @param {number} aspectRatio Aspect ratio of window's inner-bounds.
 * @private
 */
camera.Camera.prototype.onAspectRatio_ = function(aspectRatio) {
  this.onWindowResize_(aspectRatio);
};

/**
 * Shows an error message.
 * @param {string} identifier Identifier of the error.
 * @param {string} message Message for the error.
 * @param {string=} opt_hint Optional hint for the error message.
 * @private
 */
camera.Camera.prototype.onError_ = function(identifier, message, opt_hint) {
  // TODO(yuli): Implement error-identifier to look up messages/hints and handle
  // multiple errors. Make 'error' a view to block buttons on other views.
  document.body.classList.add('has-error');
  this.context_.hasError = true;
  document.querySelector('#error-msg').textContent = message;
  document.querySelector('#error-msg-hint').textContent = opt_hint || '';
};

/**
 * Removes the error message when an error goes away.
 * @param {string} identifier Identifier of the error.
 * @private
 */
camera.Camera.prototype.onErrorRecovered_ = function(identifier) {
  this.context_.hasError = false;
  document.body.classList.remove('has-error');
};

/**
 * Shows a non-intrusive toast message.
 * @param {string} message Message to be shown.
 * @param {boolean} named True if it's i18n named message, false otherwise.
 * @private
 */
camera.Camera.prototype.onToast_ = function(message, named) {
  this.toast_.showMessage(named ? chrome.i18n.getMessage(message) : message);
};

/**
 * @type {camera.Camera} Singleton of the Camera object.
 * @private
 */
camera.Camera.instance_ = null;

/**
 * Creates the Camera object and starts screen capturing.
 */
document.addEventListener('DOMContentLoaded', () => {
  var appWindow = chrome.app.window.current();
  if (!camera.Camera.instance_) {
    var inner = appWindow.innerBounds;
    camera.Camera.instance_ = new camera.Camera(inner.width / inner.height);
  }
  camera.Camera.instance_.start();
  appWindow.show();
});
