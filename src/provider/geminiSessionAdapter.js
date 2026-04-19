"use strict";

const { GeminiLiveSession } = require("../vendor/geminiLiveSession");

function createGeminiSessionAdapter(options = {}) {
  return new GeminiLiveSession(options);
}

module.exports = { createGeminiSessionAdapter };
