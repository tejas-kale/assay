# 04: Compute trusted-SQL lexical token coverage and show it on the Overview header

**What to build:** Assay computes the analysis's trusted-SQL coverage across every SQL run as the share of lexical SQL
tokens that came from approved block bodies and dictionary definition expansions, writes the figure from the server, and
shows it in the Overview tab header. Spec:
https://github.com/tejas-kale/assay/issues/9#issuecomment-6879918940.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Across all SQL runs in the analysis, coverage is computed as lexical tokens coming from approved block bodies and dictionary definition expansions divided by total lexical tokens in the expanded SQL (ignoring comments and whitespace).
- [ ] SQL runs made with the `trusted` tool count as 100% trusted (all lexical tokens trusted), and Python runs (including Python `trusted` calculations) are excluded from both numerator and denominator.
- [ ] Partial includes (`{{ block(...) }}` and `{{ definition(...) }}`) count by the lexical tokens of their expanded trusted bodies/expressions relative to the full expanded query.
- [ ] The server updates and writes the coverage figure as SQL and trusted runs are recorded, and the Overview tab header displays the trusted-SQL coverage share.
