
const puppeteer = require('puppeteer-extra'); // eslint-disable-line import/no-extraneous-dependencies
const pluginStealth = require('puppeteer-extra-plugin-stealth');

const Instauto = require('./index'); // eslint-disable-line import/no-unresolved

const options = {
  cookiesPath: './cookies.json',
  // Will store a list of all users that have been followed before, to prevent future re-following.
  followedDbPath: './followed.json',
  // Will store all unfollowed users here
  unfollowedDbPath: './unfollowed.json',
  // Will store all liked posts here
  likedDbPath: './liked.json',

  username: 'cofetty',
  password: 'MKioPxeWNxgCHqZeYfRdZ7pz',

  // Global limit that prevents follow or unfollows (total) to exceed this number over a sliding window of one hour:
  maxFollowsPerHour: 30,
  // Global limit that prevents follow or unfollows (total) to exceed this number over a sliding window of one day:
  maxFollowsPerDay: 500,
  // (NOTE setting the above parameters too high will cause temp ban/throttle)
  maxLikesPerHour: 30,
  maxLikesPerDay: 500,

  // Don't follow users that have a followers / following ratio less than this:
  followUserRatioMin: 0.2,
  // Don't follow users that have a followers / following ratio higher than this:
  followUserRatioMax: 4.0,
  // Don't follow users who have more followers than this:
  followUserMaxFollowers: null,
  // Don't follow users who have more people following them than this:
  followUserMaxFollowing: null,
  // Don't follow users who have less followers than this:
  followUserMinFollowers: null,
  // Don't follow users who have more people following them than this:
  followUserMinFollowing: null,

  dontUnfollowUntilTimeElapsed: 7 * 24 * 60 * 60 * 1000,

  // Usernames that we should not touch, e.g. your friends and actual followings
  excludeUsers: [],

  // If true, will not do any actions (defaults to true)
  dryRun: false
};

(async () => {
  let browser;

  try {
    puppeteer.use(pluginStealth());
    browser = await puppeteer.launch({
      headless: true
      // pipe: true,
      // slowMo: 300,
      // executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      // userDataDir: '/Users/anna/Library/Application Support/Google/Chrome'
      // args: ['--no-sandbox']
    });

    const instauto = await Instauto(browser, options);

    const posts = `4) https://www.instagram.com/p/B5IJdtkputq
    5) https://www.instagram.com/p/B4yH97mo5AP
    6) https://www.instagram.com/p/B5INSgWngvE
    7) https://www.instagram.com/p/B5IDhlOHJb0
    8) https://www.instagram.com/p/B5Hz8OBKjs1
    9) https://www.instagram.com/p/B47xCVihaR4
    10) https://www.instagram.com/p/B42z3JQJxSY
    11) https://www.instagram.com/p/B48_rmBpcDI
    12) https://www.instagram.com/p/B5EI__8jp3o
    13) https://www.instagram.com/p/B5IXnusl90u
    14) https://www.instagram.com/p/B5GXLhTFfsg
    15) https://www.instagram.com/p/B5Iig5UIlY5
    16) https://www.instagram.com/p/B5IfLQ1ARpy
    17) https://www.instagram.com/p/B48XQBiAjnF
    18) https://www.instagram.com/p/B5IkjDun2D8
    19) https://www.instagram.com/p/B5EhF9Jgb2c
    20) https://www.instagram.com/p/B5ICiobj-pZ
    21) https://www.instagram.com/p/B5IaqOUAVGd
    22) https://www.instagram.com/p/B5IzEHpB2N3
    23) https://www.instagram.com/p/B5IuWnsH-rN
    24) https://www.instagram.com/p/BPVPuHQhai6
    25) https://www.instagram.com/p/BQVmMrOBwgi
    26) https://www.instagram.com/p/B5I6uOrIyla
    27) https://www.instagram.com/p/B5Idp6mpX6a
    28) https://www.instagram.com/p/B5I7AnOlOwE
    29) https://www.instagram.com/p/BvPbsD-hHi8
    30) https://www.instagram.com/p/B5IzHPfBD7V
    31) https://www.instagram.com/p/B5IUh7KorI-
    32) https://www.instagram.com/p/B5IWg85pSUH
    33) https://www.instagram.com/p/B5Irg1mpD6S
    34) https://www.instagram.com/p/B5I8HsWpFTW
    35) https://www.instagram.com/p/B5JU67Vl3EY
    36) https://www.instagram.com/p/B5JT_2XBDGz
    37) https://www.instagram.com/p/B5Af4x1g3vm
    38) https://www.instagram.com/p/B5JXfsMAGDN
    39) https://www.instagram.com/p/B5Jl3EmnInE
    40) https://www.instagram.com/p/B5IZnAGlwYP
    41) https://www.instagram.com/p/B5HzqecnkOS
    42) https://www.instagram.com/p/B5JWxLfgxo2
    43) https://www.instagram.com/p/B5IEAv7hCyn
    44) https://www.instagram.com/p/B5JwuYkAK0O
    45) https://www.instagram.com/p/B5F3DIBFlif
    46) https://www.instagram.com/p/B5A0KEYlx1q
    47) https://www.instagram.com/p/B4z2FzIlDfR
    48) https://www.instagram.com/p/B4vYFzVFOSB
    49) https://www.instagram.com/p/B5IcxNCHtMh
    50) https://www.instagram.com/p/B5JBC3xgryc
    51) https://www.instagram.com/p/B5KPnngoMyK`
      .replace(/\d+\) /g, '')
      .replace(/https:\/\/www.instagram.com\/p\//g, '')
      .replace(/ /g, '')
      .split('\n');
    await instauto.likePosts(posts);

    // This is used to unfollow people who have been automatically followed
    // but are not following us back, after some time has passed
    // (config parameter dontUnfollowUntilTimeElapsed)
    // await instauto.unfollowNonMutualFollowers();

    await instauto.sleep(5 * 60 * 1000);

    console.log('Done running');

    await instauto.sleep(30000);
  } catch (err) {
    console.error(err);
  } finally {
    console.log('Closing browser');
    if (browser) await browser.close();
  }
})();
