// plugins/withPrivateRecents.js
// Stops Android keeping a picture of the app in its recent-apps screen, which could otherwise show someone's private
// notes and titles to anyone holding the unlocked phone. This is an Expo "config plugin": a small build-time script
// that edits the generated Android code, which isn't in this repo because each build recreates it.
//
// It uses setRecentsScreenshotEnabled, which Android has had since version 13. Recents then shows a blank card once the
// app is in the background, though opening recents directly from the app still shows a live view of it until the person
// leaves. Older versions ignore this path and still show the picture. The stronger FLAG_SECURE setting would cover those
// too, but it also blocks ordinary screenshots, which someone may reasonably want of their own stats.

const { withMainActivity } = require('expo/config-plugins');

// Added at the start of the screen's startup code. The version check matters: the call doesn't exist on older Android.
const LINE = `    if (android.os.Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)\n`;
// Matches the first line of the startup function in the Kotlin code Expo generates, e.g. "override fun onCreate(savedInstanceState: Bundle?) {".
const ON_CREATE = /override fun onCreate\(savedInstanceState: Bundle\?\) \{\n/;

/**
 * Edits the app's main Android screen at build time.
 * In: Expo's build configuration. Out: the same, with the line added. Stops the build if it can't find the place, so a
 * future Expo change can't quietly remove this protection. Running twice changes nothing.
 */
module.exports = function withPrivateRecents(config) {
  return withMainActivity(config, (modConfig) => {
    const source = modConfig.modResults.contents;
    if (source.includes('setRecentsScreenshotEnabled')) return modConfig;
    if (modConfig.modResults.language !== 'kt' || !ON_CREATE.test(source)) {
      throw new Error('withPrivateRecents: could not find onCreate in MainActivity.');
    }
    modConfig.modResults.contents = source.replace(ON_CREATE, (found) => `${found}${LINE}`);
    return modConfig;
  });
};
