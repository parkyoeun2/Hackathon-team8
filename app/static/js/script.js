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

// aside
$(document).ready(function(){

    var asideOpenBtn = $('.route-form .btn-primary'),
        home = $('.home'),
        aside = $('.parse-sheet');

    // < 다시 입력하기 버튼이 없으면 맨 위에 추가
    if (aside.find('.back-link').length === 0) {
        aside.prepend('<button type="button" class="back-link">다시 입력하기</button>');
    }

    var asideCloseBtn = aside.find('.back-link, .close');

    // 시트가 </main> 바깥에 있으면 모바일 카드 안쪽으로 이동
    if (!aside.parent().hasClass('home')) {
        home.append(aside);
    }

    asideOpenBtn.click(function(e){
        e.preventDefault();

        // 입력한 텍스트 반영
        var text = $('#today-status').val();
        if (text && text.trim() !== '') {
            aside.find('.parse-status-value').text(text.trim());
        }

        //검정 선 제거: border: 'none', outline: 'none' 추가!
        aside.removeAttr('hidden').css({
            'display': 'flex',
            'flex-direction': 'column',
            'position': 'static',
            'width': '100%',
            'border': 'none',
            'outline': 'none',
            'box-shadow': 'none',
            'margin-top': '18px'
        });

        home.addClass('is-confirming');
    });

    // 3. '< 다시 입력하기' 클릭 시 -> 원래 화면으로 복귀
    asideCloseBtn.click(function(e){
        e.preventDefault();
        aside.css('display', 'none');
        home.removeClass('is-confirming');
    });

    // 4. '입력 완료' 버튼 클릭 시에는 창이 뜨지 않도록 방지
    $('.btn-ai').click(function(e){
        e.preventDefault();
    });

});