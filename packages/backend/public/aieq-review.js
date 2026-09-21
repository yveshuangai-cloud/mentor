// Closed-choice product review shown only on the dedicated YVES review URL.
// It reuses the staging-only team-feedback store; normal players never see it.
(() => {
  const params = new URLSearchParams(location.search)
  if (params.get('review') !== 'yves') return

  const decisions = [
    {
      key: 'questions',
      title: 'Q5～Q8 正式文字',
      recommended: '採用目前手機版文字',
      alternative: '由 YVES 提供新版逐字稿',
      reason: '目前版本已完成手機排版與全組合計分驗證。',
    },
    {
      key: 'c_signal',
      title: 'C 選項如何計分',
      recommended: '保留微弱傾向訊號',
      alternative: '完全不計入四軸',
      reason: '可避免整條傾向只被一道題目決定。',
    },
    {
      key: 'neutral',
      title: '接近中間值時',
      recommended: '仍顯示較接近的一側',
      alternative: '新增中性結果 X',
      reason: '保留完整 16 種動物結果，也不增加難懂的未知狀態。',
    },
    {
      key: 'audience',
      title: '情境定位',
      recommended: '維持目前職場版',
      alternative: '改成一般生活版',
      reason: '先把職場受眾做準，題目情境會更一致。',
    },
    {
      key: 'tone',
      title: '結果解讀語氣',
      recommended: '保留溫暖大白話',
      alternative: '改回顧問式短句',
      reason: '手機閱讀更直觀，也比較像在理解玩家而不是下判語。',
    },
    {
      key: 'duration',
      title: '對外體驗時間',
      recommended: '標示約 1 分鐘',
      alternative: '標示約 2 分鐘',
      reason: '八題實際體驗接近一分鐘。',
    },
  ]

  const spot = key => `review:${key}`
  const selected = key => teamMine[spot(key)]?.verdict

  function summary() {
    const answered = decisions.filter(d => selected(d.key)).length
    if (answered < decisions.length) return `已完成 ${answered}／${decisions.length} 項決策`
    const recommended = decisions.filter(d => selected(d.key) === 'good').length
    return `審稿完成：${recommended} 項採用建議，${decisions.length - recommended} 項選擇替代方案。`
  }

  function render() {
    const result = document.querySelector('#resultCard .result')
    if (!result) return
    let panel = document.querySelector('#yvesReview')
    if (!panel) {
      panel = document.createElement('section')
      panel.id = 'yvesReview'
      panel.className = 'yves-review'
      result.append(panel)
    }
    panel.innerHTML = `
      <div class="eyebrow">YVES REVIEW MODE</div>
      <h2>玩完之後，請確認正式版本</h2>
      <p class="review-intro">每一項只要選一個。標示「建議」的是目前經過手機體驗與計分驗證後的建議方案。</p>
      <div class="review-decisions">
        ${decisions.map((d, index) => {
          const value = selected(d.key)
          return `<article class="review-decision" data-review-key="${d.key}">
            <div class="review-number">0${index + 1}</div>
            <h3>${d.title}</h3>
            <p>${d.reason}</p>
            <button type="button" data-review-value="good"${value === 'good' ? ' class="selected"' : ''}>
              <b>建議</b><span>${d.recommended}</span>
            </button>
            <button type="button" data-review-value="issue"${value === 'issue' ? ' class="selected alternative"' : ' class="alternative"'}>
              <span>${d.alternative}</span>
            </button>
          </article>`
        }).join('')}
      </div>
      <div class="review-summary${decisions.every(d => selected(d.key)) ? ' complete' : ''}">${summary()}</div>
    `
    panel.querySelectorAll('[data-review-value]').forEach(button => {
      button.onclick = async () => {
        const card = button.closest('[data-review-key]')
        const key = card.dataset.reviewKey
        card.querySelectorAll('button').forEach(item => { item.disabled = true })
        try {
          const verdict = button.dataset.reviewValue
          await api('/team-feedback', {
            method: 'POST',
            body: JSON.stringify({
              spot: spot(key), verdict,
              typeCode: state?.result?.typeKey,
              sessionId: state?.session?.id,
            }),
          })
          teamMine[spot(key)] = { verdict, comment: null }
          render()
        } catch (error) {
          card.querySelectorAll('button').forEach(item => { item.disabled = false })
          const message = document.createElement('p')
          message.className = 'review-error'
          message.textContent = `暫時無法保存，請再按一次。${error?.message ? `（${error.message}）` : ''}`
          card.append(message)
        }
      }
    })
  }

  const observer = new MutationObserver(render)
  observer.observe(document.querySelector('#resultCard'), { childList: true })
  render()
})()
