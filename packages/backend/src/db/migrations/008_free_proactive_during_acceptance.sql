-- Yves 驗收期間，主動履約不得因 0 點餘額被跳過。
UPDATE point_rules
SET cost = 0,
    enabled = TRUE,
    description = 'Free during Yves acceptance testing',
    updated_by = 'migration:008'
WHERE gate = 'proactive';
