const { defineConfig } = require('cypress');

module.exports = defineConfig({
  e2e: {
    baseUrl: 'http://127.0.0.1:8000',
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: false,
    allowCypressEnv: false,
    video: false,
    defaultCommandTimeout: 10000
  }
});
