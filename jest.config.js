module.exports = {
  moduleFileExtensions: ["ts", "js"],
  transform: {
    "^.+\\.(ts|tsx)$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2015",
        },
      },
    ],
    "^.+\\.js$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2015",
          parser: { syntax: "ecmascript" },
        },
      },
    ],
  },
  // cookie 2.x ships ESM only and is required by light-my-request (fastify)
  transformIgnorePatterns: ["/node_modules/(?!(cookie)/)"],
  coverageProvider: "v8",
  testMatch: ["/**/src/**/*.spec.(ts|js)"],
  testEnvironment: "node",
};
