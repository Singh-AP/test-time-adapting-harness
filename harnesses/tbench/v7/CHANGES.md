# Changes from v6

Adds an independent test designer: before the agent starts, a fresh session inspects the container and predicts the hidden tests (requirements, domain rules and data fields that must be used, variant inputs, prohibitions). The predictions are appended to the agent's first message and given to the reviewer. Aimed at failures where the agent never considers a requirement the tests check.
