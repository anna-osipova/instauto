const chalk = require('chalk');

async function getPageJson(page) {
  return JSON.parse(await (await (await page.$('pre')).getProperty('textContent')).jsonValue());
}

function shuffleArray(input) {
  const arr = Array.from(input);
  for (let i = arr.length - 1; i > 0; i--) { // eslint-disable-line no-plusplus
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function shouldInteract(percentage) {
  return Math.random() * 100 <= percentage;
}

class InstagramError extends Error {

}

async function testActionBlock(page) {
  const elements = await page.$x('//h3[text()=\'Action Blocked\']');
  if (elements.length !== 0) {
    throw new InstagramError('ACTION_BLOCKED');
  }
}

const logger = {
  log: (...args) => {
    const now = new Date().toTimeString().split(' ')[0];
    console.log(chalk.grey(`[${now}]`), ...args);
  },
  error: (...args) => console.error(...args)
};

module.exports = { getPageJson, InstagramError, logger, shuffleArray, shouldInteract, testActionBlock };
