const reviews = await parallel("review", {
  correctness: () => agent("Review the current changes for correctness issues.", {
    sandbox: "read-only",
  }),
  security: () => agent("Review the current changes for security risks.", {
    sandbox: "read-only",
  }),
  tests: () => agent("Review the current changes for missing test coverage.", {
    sandbox: "read-only",
  }),
});

return await agent(
  prompt("Summarize and prioritize these findings:\n\n{reviews}", { reviews }),
  { sandbox: "read-only" },
);
