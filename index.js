const assert = require('assert');
const fs = require('fs-extra');
const _ = require('lodash');
const UserAgent = require('user-agents');
const chalk = require('chalk');
const { graphqlUrl, instagramBaseUrl, queryHash, variables } = require('./config');
const { getPageJson, InstagramError, logger, shuffleArray, shouldInteract, testActionBlock } = require('./utils');

module.exports = async (browser, options) => {
  const {
    cookiesPath,
    followedDbPath,
    unfollowedDbPath,
    likedDbPath,

    username: myUsername,
    password,

    maxFollowsPerHour = 100,
    maxFollowsPerDay = 700,
    maxLikesPerHour = 100,
    maxLikesPerDay = 700,
    followUserRatioMin = 0.2,
    followUserRatioMax = 4.0,
    followUserMaxFollowers = null,
    followUserMaxFollowing = null,
    followUserMinFollowers = null,
    followUserMinFollowing = null,

    dontUnfollowUntilTimeElapsed = 3 * 24 * 60 * 60 * 1000,

    excludeUsers = [],

    dryRun = true
  } = options;

  assert(cookiesPath);
  assert(followedDbPath);
  assert(unfollowedDbPath);
  assert(likedDbPath);

  // State
  let page;
  let prevFollowedUsers = {};
  let prevUnfollowedUsers = {};
  let likedPosts = {};

  // TODO: refactor
  async function tryLoadDb() {
    try {
      prevFollowedUsers = keyBy(JSON.parse(await fs.readFile(followedDbPath)), 'username');
    } catch (err) {
      logger.error('Failed to load followed db');
    }
    try {
      prevUnfollowedUsers = keyBy(JSON.parse(await fs.readFile(unfollowedDbPath)), 'username');
    } catch (err) {
      logger.error('Failed to load unfollowed db');
    }
    try {
      likedPosts = _.keyBy(JSON.parse(await fs.readFile(likedDbPath)), 'postId');
    } catch (err) {
      logger.error('Failed to load like db');
    }
  }

  async function trySaveDb() {
    try {
      await fs.writeFile(followedDbPath, JSON.stringify(Object.values(prevFollowedUsers)));
      await fs.writeFile(unfollowedDbPath, JSON.stringify(Object.values(prevUnfollowedUsers)));
      await fs.writeFile(likedDbPath, JSON.stringify(Object.values(likedPosts)));
    } catch (err) {
      logger.error('Failed to save db');
    }
  }


  async function tryLoadCookies() {
    try {
      const cookies = JSON.parse(await fs.readFile(cookiesPath));
      for (const cookie of cookies) {
        await page.setCookie(cookie);
      }
    } catch (err) {
      logger.error('Failed to load cookies');
    }
  }

  async function trySaveCookies() {
    try {
      const cookies = await page.cookies();

      await fs.writeFile(cookiesPath, JSON.stringify(cookies, null, 2));
    } catch (err) {
      logger.error('Failed to save cookies');
    }
  }

  const sleep = (ms, dev = 1) => {
    const msWithDev = ((Math.random() * dev) + 1) * ms;
    console.log('Sleeping', msWithDev / 1000, 'sec');
    return new Promise(resolve => setTimeout(resolve, msWithDev));
  };

  async function addFollowedUser(user) {
    prevFollowedUsers[user.username] = user;
    await trySaveDb();
  }

  async function addUnfollowedUser(user) {
    prevUnfollowedUsers[user.username] = user;
    await trySaveDb();
  }

  async function addLikedPost(post) {
    likedPosts[post.postId] = post;
    await trySaveDb();
  }

  function getNumFollowedUsersThisTimeUnit(timeUnit) {
    const now = new Date().getTime();

    return Object.values(prevFollowedUsers).filter(u => now - u.time < timeUnit).length
      + Object.values(prevUnfollowedUsers).filter(u =>
        !u.noActionTaken && now - u.time < timeUnit).length;
  }

  function getNumLikedThisTimeUnit(timeUnit) {
    const now = new Date().getTime();

    return Object.values(likedPosts).filter((u) => now - u.time < timeUnit).length;
  }

  function hasReachedFollowedUserRateLimit() {
    const followsHour = getNumFollowedUsersThisTimeUnit(60 * 60 * 1000);
    const followsDay = getNumFollowedUsersThisTimeUnit(24 * 60 * 60 * 1000);
    logger.log(chalk.blue(`Quota: ${followsHour}/${maxFollowsPerHour} hour, ${followsDay}/${maxFollowsPerDay} day`));
    return followsHour >= maxFollowsPerHour || followsDay >= maxFollowsPerDay;
  }

  function hasReachedLikeRateLimit() {
    const likesHour = getNumLikedThisTimeUnit(60 * 60 * 1000);
    const likesDay = getNumLikedThisTimeUnit(24 * 60 * 60 * 1000);
    logger.log(chalk.blue(`Quota: ${likesHour}/${maxLikesPerHour} hour, ${likesDay}/${maxLikesPerDay} day`));
    return likesHour >= maxLikesPerHour || likesDay >= maxLikesPerDay;
  }

  function haveRecentlyFollowedUser(username) {
    const followedUserEntry = prevFollowedUsers[username];
    if (!followedUserEntry) return false; // We did not previously follow this user, so don't know
    return new Date().getTime() - followedUserEntry.time < dontUnfollowUntilTimeElapsed;
  }

  async function navigateToUser(username, retries = 0) {
    logger.log(`Navigating to user ${username}`);
    const response = await page.goto(`${instagramBaseUrl}/${encodeURIComponent(username)}`);
    await sleep(1000);
    const status = response.status();
    if (status === 200) {
      return true;
    } if (status === 404) {
      logger.log(chalk.red('User not found'));
      return false;
    } if (status === 429) {
      logger.error(chalk.red(`Got 429 Too Many Requests, retry ${retries + 1}, waiting for ~${5 * (retries + 1)} min...`));
      await sleep((retries + 1) * 5 * 60 * 1000);
      return navigateToUser(username, retries + 1);
    }
    throw new Error(`Navigate to user returned status ${response.status()}`);
  }

  async function isActionBlocked() {
    const elementHandles = await page.$x('//*[contains(text(), "Action Blocked")]');
    return elementHandles.length > 0;
  }

  async function checkActionBlocked() {
    if (await isActionBlocked()) {
      console.error('Action Blocked, waiting 24h...');
      await sleep(24 * 60 * 60 * 1000);
      throw new Error('Aborted operation due to action blocked')
    }
  }

  async function navigateToTag(tag, retries = 0) {
    logger.log(`Navigating to tag ${tag}`);
    const response = await page.goto(`${instagramBaseUrl}/explore/tags/${encodeURIComponent(tag)}`);
    await sleep(1000);
    const status = response.status();
    if (status === 200) {
      return true;
    } if (status === 404) {
      logger.log(chalk.red('Tag not found'));
      return false;
    } if (status === 429) {
      logger.error(chalk.red(`Got 429 Too Many Requests, retry ${retries + 1}, waiting for ~${5 * (retries + 1)} min...`));
      await sleep((retries + 1) * 5 * 60 * 1000);
      return navigateToTag(tag, retries + 1);
    }
    throw new Error(`Navigate to tag returned status ${response.status()}`);
  }

  async function navigateToPost(postId, retries = 0) {
    logger.log(`Navigating to post ${instagramBaseUrl}/p/${postId}`);
    const response = await page.goto(`${instagramBaseUrl}/p/${encodeURIComponent(postId)}`);
    await sleep(1000);
    const status = response.status();
    if (status === 200) {
      return true;
    }
    if (status === 404) {
      logger.log(chalk.red('Post not found'));
      return false;
    }
    if (status === 429) {
      logger.error(chalk.red(`Got 429 Too Many Requests, retry ${retries + 1}, waiting for ~${5 * (retries + 1)} min...`));
      await sleep((retries + 1) * 5 * 60 * 1000);
      return navigateToPost(postId, retries + 1);
    }
    throw new Error(`Navigate to post returned status ${response.status()}`);
  }

  async function getRecentPostsByTag({ tag, maxPages }) {
    const url = `${instagramBaseUrl}${graphqlUrl}/?query_hash=${queryHash.RECENT_BY_TAG}`;
    const graphqlVariables = {
      tag_name: tag,
      first: variables.first
    };

    const imageIds = [];
    let hasNextPage = true;
    let i = 0;

    const shouldProceed = () => hasNextPage && (maxPages == null || i < maxPages);

    while (shouldProceed()) {
      logger.log(`Page ${i} out of ${maxPages}`);
      await page.goto(`${url}&variables=${JSON.stringify(graphqlVariables)}`);
      const json = await getPageJson(page);
      const edges = _.get(json, 'data.hashtag.edge_hashtag_to_media.edges', []);
      const after = _.get(json, 'data.hashtag.edge_hashtag_to_media.page_info.end_cursor');
      hasNextPage = _.get(json, 'data.hashtag.edge_hashtag_to_media.page_info.has_next_page', false);
      _.set(graphqlVariables, { after });

      edges.forEach((e) => imageIds.push(e.node.shortcode));

      i += 1;
    }

    return imageIds;
  }

  async function findLikeButton(text) {
    const elementHandles = await page.$x(`//section/span/button/span[@aria-label='${text}']`);
    if (elementHandles.length !== 1) {
      return undefined;
    }
    return elementHandles[0];
  }

  async function findFollowUnfollowButton(text) {
    const elementHandles = await page.$x(`//header//button[text()='${text}']`);
    if (elementHandles.length !== 1) {
      return undefined;
    }
  }

  async function findFollowButton() {
    const elementHandles = await page.$x(`//header//button[text()='Follow']`);
    if (elementHandles.length > 0) elementHandles[0];

    const elementHandles2 = await page.$x(`//header//button[text()='Follow Back']`);
    if (elementHandles2.length > 0) elementHandles[0];
  }

  async function findUnfollowButton() {
    const elementHandles = await page.$x(`//header//button[text()='Following']`);
    if (elementHandles.length > 0) return elementHandles[0];

    const elementHandles2 = await page.$x(`//header//button[text()='Requested']`);
    if (elementHandles2.length > 0) return elementHandles2[0];

    const elementHandles3 = await page.$x("//header//button[*//span[@aria-label='Following']]");
    if (elementHandles3.length > 0) return elementHandles3[0];

    return undefined;
  }

  async function findUnfollowConfirmButton() {
    const elementHandles = await page.$x("//button[text()='Unfollow']");
    return elementHandles[0];
  }

  async function likeCurrentPost(postId) {
    const elementHandle = await findLikeButton('Like');
    if (!elementHandle) {
      if (await findLikeButton('Unlike')) {
        logger.log(chalk.red('Post already liked'));
        return;
      }
      throw new Error('Like button not found');
    }

    logger.log(chalk.green(`Liking post https://www.instagram.com/p/${postId}`));

    if (!dryRun) {
      await elementHandle.click();
      await sleep(5000);

      const elementHandle2 = await findLikeButton('Unlike');
      if (!elementHandle2) {
        logger.log(chalk.red('Failed to like post (button did not change state)'));
        await testActionBlock(page);
      }

      await addLikedPost({ postId, time: new Date().getTime() });
    }

    await sleep(1000);
  }

  // NOTE: assumes we are on this page
  async function followCurrentUser(username) {
    const elementHandle = await findFollowButton();
    if (!elementHandle) throw new Error('Follow button not found');

    logger.log(chalk.green(`Following user https://www.instagram.com/${username}`));

    if (!dryRun) {
      await elementHandle.click();
      await sleep(5000);

      const elementHandle2 = await findUnfollowButton();
      if (!elementHandle2) {
        logger.log(chalk.red('Failed to follow user (button did not change state)'));
        await testActionBlock(page);
      }

      await addFollowedUser({ username, time: new Date().getTime() });
    }

    await sleep(1000);
  }

  // See https://github.com/timgrossmann/InstaPy/pull/2345
  // https://github.com/timgrossmann/InstaPy/issues/2355
  async function unfollowCurrentUser(username) {
    logger.log(`Unfollowing user https://www.instagram.com/${username}`);

    const res = { username, time: new Date().getTime() };

    const elementHandle = await findUnfollowButton();
    if (!elementHandle) {
      const elementHandle2 = await findFollowButton();
      if (elementHandle2) {
        logger.log(chalk.red('User has been unfollowed already'));
        res.noActionTaken = true;
      } else {
        logger.log(chalk.red('Failed to find unfollow button'));
        res.noActionTaken = true;
      }
    }

    if (elementHandle && !dryRun) {
      await elementHandle.click();
      await sleep(1000);
      const confirmHandle = await findUnfollowConfirmButton();
      if (confirmHandle) await confirmHandle.click();

      await sleep(5000);

      await testActionBlock(page);

      const elementHandle2 = await findFollowButton();
      if (!elementHandle2) {
        logger.log(chalk.red('Failed to unfollow user (button did not change state)'));
      }
    }

    if (!dryRun) {
      await addUnfollowedUser(res);
    }

    await sleep(1000);

    return res;
  }

  const isLoggedIn = async () => (await page.$x('//nav')).length === 2;

  async function getCurrentUser() {
    return page.evaluate(() => // eslint-disable-line no-loop-func
      window._sharedData.entry_data.ProfilePage[0].graphql.user); // eslint-disable-line no-undef,no-underscore-dangle,max-len
  }

  async function getFollowersOrFollowing({
    userId, getFollowers = false, maxPages, shouldProceed: shouldProceedArg,
  }) {
    const followersUrl = `${instagramBaseUrl}${graphqlUrl}/?query_hash=${queryHash.FOLLOWERS}`;
    const followingUrl = `${instagramBaseUrl}${graphqlUrl}/?query_hash=${queryHash.FOLLOWING}`;

    const graphqlVariables = {
      id: userId,
      first: variables.first
    };

    const userIds = [];

    let hasNextPage = true;
    let i = 0;

    const shouldProceed = () => {
      if (!hasNextPage) return false;
      const isBelowMaxPages = maxPages == null || i < maxPages;
      if (shouldProceedArg) return isBelowMaxPages && shouldProceedArg(outUsers);
      return isBelowMaxPages;
    };

    while (shouldProceed()) {
      logger.log(`Page ${i} out of ${maxPages}`);
      const url = `${getFollowers ? followersUrl : followingUrl}&variables=${JSON.stringify(graphqlVariables)}`;
      await page.goto(url);
      const json = await getPageJson(page);

      const subPropName = getFollowers ? 'edge_followed_by' : 'edge_follow';

      const pageInfo = json.data.user[subPropName].page_info;
      const { edges } = json.data.user[subPropName];

      edges.forEach((e) => userIds.push(e.node.username));

      graphqlVariables.after = pageInfo.end_cursor;
      hasNextPage = pageInfo.has_next_page;
      i += 1;

      if (shouldProceed()) {
        console.log(`Has more pages (current ${i})`);

        await sleep(300);
      }

    return userIds;
  }

  async function likeByTag(tag, {
    maxLikes = 100,
    percentage = 50
  }) {
    if (hasReachedLikeRateLimit()) {
      logger.log(chalk.red('Have reached like rate limit, stopping'));
      return;
    }

    logger.log(`Liking posts by tag ${tag}`);

    let numLiked = 0;

    const maxPages = Math.ceil(maxLikes / 20);
    const fetchedPosts = await getRecentPostsByTag({ tag, maxPages });
    logger.log(`Fetched Posts: ${maxPages} pages, ${fetchedPosts.length} total`);

    // Skip previously liked
    const posts = fetchedPosts.filter((i) => !likedPosts[i]);

    for (const post of posts) {
      try {
        if (numLiked >= maxLikes) {
          logger.log(chalk.red('Have reached like max amount, stopping'));
          return;
        }
        if (hasReachedLikeRateLimit()) {
          logger.log(chalk.red('Have reached like rate limit, pausing'));
          await sleep(15 * 60 * 1000);
        }

        const result = await navigateToPost(post);
        if (result) {
          const interact = shouldInteract(percentage);
          if (interact) {
            await likeCurrentPost(post);
            numLiked += 1;
          } else {
            logger.log(chalk.cyan(`Skipping, interacting percentage is set to ${percentage}%`));
          }
        }
        await sleep(10000);
      } catch (err) {
        if (err.message.indexOf('Protocol error') > -1) {
          throw err;
        }
        if (err instanceof InstagramError) {
          logger.error('Action blocked by Instagram');
          throw err;
        }
        logger.error(`Failed to process post ${post}`, err);
        await sleep(20000);
      }
    }
  }

  async function likePosts(posts) {
    const failedPosts = [];
    for (const postId of posts) {
      if (hasReachedLikeRateLimit()) {
        logger.log(chalk.red('Have reached like rate limit, pausing'));
        await sleep(15 * 60 * 1000);
      }

      logger.log(`Processing post ${posts.indexOf(postId) + 1}/${posts.length}`);

      try {
        await navigateToPost(postId);
        await likeCurrentPost(postId);
        await sleep(10000);
      } catch (err) {
        if (err.message.indexOf('Protocol error') > -1) {
          throw err;
        }
        if (err instanceof InstagramError) {
          logger.error('Action blocked by Instagram');
          throw err;
        }
        failedPosts.push(postId);
        logger.error(`Failed to process post ${postId}`, err);
        await sleep(20000);
      }
    }
    failedPosts.forEach((postId) => logger.log(chalk.red(`Failed to like post ${instagramBaseUrl}/p/${postId}`)));
  }

  async function followUserFollowers(username, {
    maxFollowsPerUser = 5, maxPages = 10, skipPrivate = false
  } = {}) {
    if (hasReachedFollowedUserRateLimit()) {
      logger.log(chalk.red('Have reached follow/unfollow rate limit, stopping'));
      return;
    }

    logger.log(`Following the followers of ${username}`);

    let numFollowedForThisUser = 0;

    await navigateToUser(username);

    // Check if we have more than enough users that are not previously followed
    const shouldProceed = usersSoFar => (
      usersSoFar.filter(u => !prevFollowedUsers[u]).length < maxFollowsPerUser + 5
    );
    const userData = await getCurrentUser();
    let followers = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: true,
      shouldProceed,
      maxPages
    });

    logger.log(`Fetched Followers: ${maxPages} pages, ${followers.length} total`);

    // Filter again
    followers = shuffleArray(followers).filter(f => !prevFollowedUsers[f]);

    for (const follower of followers) {
      try {
        if (numFollowedForThisUser >= maxFollowsPerUser) {
          logger.log(chalk.red('Have reached followed limit for this user, stopping'));
          return;
        }
        if (hasReachedFollowedUserRateLimit()) {
          logger.log(chalk.red('Have reached follow/unfollow rate limit, pausing'));
          await sleep(15 * 60 * 1000);
        }

        await navigateToUser(follower);

        const graphqlUser = await getCurrentUser();
        const followedByCount = graphqlUser.edge_followed_by.count;
        const followsCount = graphqlUser.edge_follow.count;
        const isPrivate = graphqlUser.is_private;

        const ratio = followedByCount / (followsCount || 1);

        if (isPrivate && skipPrivate) {
          logger.log(chalk.yellow('User is private, skipping'));
        } else if (
          (followUserMaxFollowers != null && followedByCount > followUserMaxFollowers)
          || (followUserMaxFollowing != null && followsCount > followUserMaxFollowing)
          || (followUserMinFollowers != null && followedByCount < followUserMinFollowers)
          || (followUserMinFollowing != null && followsCount < followUserMinFollowing)
        ) {
          logger.log(chalk.yellow(`User has too many or too few followers (${followedByCount}) or following (${followsCount}), skipping`));
        } else if (
          (followUserRatioMax != null && ratio > followUserRatioMax)
          || (followUserRatioMin != null && ratio < followUserRatioMin)
        ) {
          logger.log(chalk.yellow(`User has too many followers (${followedByCount}) compared to follows (${followsCount}) or opposite, skipping`));
        } else {
          await followCurrentUser(follower);
          numFollowedForThisUser += 1;
          await sleep(10000);
        }
        await sleep(3000);
      } catch (err) {
        if (err.message.indexOf('Protocol error') > -1) {
          throw err;
        }
        if (err instanceof InstagramError) {
          logger.error('Action blocked by Instagram');
          throw err;
        }
        logger.error(`Failed to process follower ${follower}`, err);
        await sleep(20000);
      }
    }
  }

  async function safelyUnfollowUserList(usersToUnfollow, limit) {
    logger.log(`Unfollowing ${usersToUnfollow.length} users`);

    let i = 0; // Number of people processed
    let j = 0; // Number of people actually unfollowed (button pressed)

    for (const username of usersToUnfollow) {
      try {
        const userFound = await navigateToUser(username);

        if (!userFound) {
          await addUnfollowedUser({ username, time: new Date().getTime(), noActionTaken: true });
          await sleep(3000);
        } else {
          const { noActionTaken } = await unfollowCurrentUser(username);

          if (noActionTaken) {
            await sleep(3000);
          } else {
            await sleep(15000);
            j += 1;

            if (j % 10 === 0) {
              logger.log('Have unfollowed 10 users since last sleep. Sleeping');
              await sleep(10 * 60 * 1000, 0.1);
            }
          }
        }

        i += 1;
        logger.log(`Have now unfollowed ${i} users of total ${usersToUnfollow.length}`);

        if (limit && j >= limit) {
          logger.log(`Have unfollowed limit of ${limit}, stopping`);
          return;
        }

        if (hasReachedFollowedUserRateLimit()) {
          logger.log(chalk.red('Have reached follow/unfollow rate limit, pausing'));
          await sleep(15 * 60 * 1000);
        }
      } catch (err) {
        if (err.message.indexOf('Protocol error') > -1) {
          throw err;
        }
        logger.error('Failed to unfollow, continuing with next', err);
      }
    }
  }

  async function unfollowNonMutualFollowers({ limit } = {}) {
    logger.log('Unfollowing non-mutual followers...');
    await page.goto(`${instagramBaseUrl}/${myUsername}`);
    const userData = await getCurrentUser();

    const allFollowers = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: true
    });
    logger.log({ allFollowers });
    const allFollowing = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: false
    });
    logger.log({ allFollowing });

    const usersToUnfollow = allFollowing.filter((u) => {
      if (allFollowers.includes(u)) return false; // Follows us
      if (excludeUsers.includes(u)) return false; // User is excluded by exclude list
      if (haveRecentlyFollowedUser(u)) {
        logger.log(chalk.yellow(`Have recently followed user ${u}, skipping`));
        return false;
      }
      return true;
    });

    logger.log('usersToUnfollow', JSON.stringify(usersToUnfollow));

    await safelyUnfollowUserList(usersToUnfollow, limit);
  }

  async function unfollowAllUnknown({ limit } = {}) {
    logger.log('Unfollowing all except excludes and auto followed');
    await page.goto(`${instagramBaseUrl}/${myUsername}`);
    const userData = await getCurrentUser();

    const allFollowing = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: false
    });
    logger.log({ allFollowing });

    const usersToUnfollow = allFollowing.filter((u) => {
      if (prevFollowedUsers[u]) return false;
      if (excludeUsers.includes(u)) return false; // User is excluded by exclude list
      return true;
    });

    logger.log('usersToUnfollow', JSON.stringify(usersToUnfollow));

    await safelyUnfollowUserList(usersToUnfollow, limit);
  }

  async function unfollowOldFollowed({ ageInDays, limit, maxPages = 100 } = {}) {
    assert(ageInDays);

    logger.log(`Unfollowing currently followed users who were auto-followed more than ${ageInDays} days ago...`);

    await page.goto(`${instagramBaseUrl}/${myUsername}`);
    const userData = await getCurrentUser();
    const allFollowing = await getFollowersOrFollowing({
      userId: userData.id,
      maxPages,
      getFollowers: false
    });
    logger.log({ allFollowing });

    const usersToUnfollow = allFollowing.filter(u =>
      prevFollowedUsers[u] &&
      !excludeUsers.includes(u) &&
      (new Date().getTime() - prevFollowedUsers[u].time) / (1000 * 60 * 60 * 24) > ageInDays)
      .slice(0, limit);

    logger.log('usersToUnfollow', JSON.stringify(usersToUnfollow));

    await safelyUnfollowUserList(usersToUnfollow, limit);
  }

  async function listManuallyFollowedUsers() {
    await page.goto(`${instagramBaseUrl}/${myUsername}`);
    const userData = await getCurrentUser();

    const allFollowing = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: false
    });

    return allFollowing.filter(u =>
      !prevFollowedUsers[u] && !excludeUsers.includes(u));
  }

  function getPage() {
    return page;
  }

  page = await browser.newPage();
  const userAgent = new UserAgent({ deviceCategory: 'desktop' });
  await page.setUserAgent(userAgent.toString());
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    pragma: 'no-cache'
  });

  await tryLoadCookies();
  await tryLoadDb();

  // console.log({ prevFollowedUsers });

  await page.goto(`${instagramBaseUrl}/`);
  await sleep(3000);

  if (!(await isLoggedIn())) {
    assert(myUsername);
    assert(password);

    await page.click('a[href="/accounts/login/?source=auth_switcher"]');
    await sleep(1000);
    await page.type('input[name="username"]', myUsername, { delay: 50 });
    await sleep(1000);
    await page.type('input[name="password"]', password, { delay: 50 });
    await sleep(1000);

    const loginButton = (await page.$x("//button[.//text() = 'Log In']"))[0];
    await loginButton.click();
  }

  await sleep(3000);

  let warnedAboutLoginFail = false;
  while (!(await isLoggedIn())) {
    if (!warnedAboutLoginFail) logger.log(chalk.red('WARNING: Login has not succeeded. This could be because of a "suspicious login attempt"-message. If that is the case, then you need to run puppeteer with headless false and complete the process.'));
    warnedAboutLoginFail = true;
    await sleep(5000);
  }

  await trySaveCookies();

  logger.log(`Have followed/unfollowed ${getNumFollowedUsersThisTimeUnit(60 * 60 * 1000)} in the last hour`);
  logger.log(`Have followed/unfollowed ${getNumFollowedUsersThisTimeUnit(24 * 60 * 60 * 1000)} in the last 24 hours`);

  return {
    followUserFollowers,
    unfollowNonMutualFollowers,
    unfollowAllUnknown,
    unfollowOldFollowed,
    followCurrentUser,
    unfollowCurrentUser,
    sleep,
    listManuallyFollowedUsers,
    getFollowersOrFollowing,
    safelyUnfollowUserList,
    getPage,
    likeByTag,
    likePosts
  };
};
