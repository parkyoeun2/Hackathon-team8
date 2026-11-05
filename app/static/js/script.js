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