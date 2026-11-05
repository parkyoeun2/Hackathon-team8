// 프론트엔드2 자바스크립트 연결 코드
const routeCards = document.querySelectorAll('.route-card');

routeCards.forEach(card => {
  card.addEventListener('click', (e) => {
    // "이 경로 보기 →" 링크 클릭 시에는 페이지 이동을 위해 전파 허용
    if (e.target.closest('.route-link')) return;

    // 모든 카드의 선택 클래스 해제 후 클릭된 카드만 녹색(.is-selected) 적용
    routeCards.forEach(c => {
      c.classList.remove('is-selected');
      c.setAttribute('aria-checked', 'false');
    });

    card.classList.add('is-selected');
    card.setAttribute('aria-checked', 'true');
  });

  // 키보드 접근성 (Enter/Space 키 선택 지원)
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (!e.target.closest('.route-link')) {
        e.preventDefault();
        card.click();
      }
    }
  });
});