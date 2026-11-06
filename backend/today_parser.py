"""오늘 상태를 여섯 개의 일시적 조건으로 해석하는 규칙 기반 파서.

표현 목록과 짧은 문맥만 사용하며 한국어 전체 문법을 이해하지는 않는다.
질문·가정·추측·과거 표현·상충하는 진술은 해당 조건을 생략한다.
결과는 항상 사용자 확인이 필요하며, 원문을 저장하거나 로그로 남기지 않는다.
캐리어와 유모차에 대한 공유 부정은 같은 소유·사용 문맥으로 처리한다.
"""

from __future__ import annotations

from dataclasses import dataclass
import re


class InvalidTextError(ValueError):
    """오늘 상태 입력이 문자열·길이 계약에 맞지 않음."""


_INVALID_TEXT_MESSAGE = "오늘 상태는 공백을 제외한 1~500자로 입력해 주세요."
_UNKNOWN_WARNING = "인식 가능한 이동 상태를 찾지 못했습니다. 적용할 상태를 직접 선택해 주세요."
_UNCERTAIN_WARNING = "모호하거나 상충하는 상태는 자동 적용하지 않았습니다. 직접 확인해 주세요."
_WHITESPACE = re.compile(r"[\s\u200b\ufeff]+")

_KEYWORDS = re.compile(
    r"(?P<suitcase>캐리어|여행\s*가방)"
    r"|(?P<stroller>유모차)"
    r"|(?P<injuredLeg>다리|발목|무릎|목발)"
    r"|(?P<tired>피곤|지쳤|지치|힘들)"
    r"|(?P<avoidStairs>계단)"
    r"|(?P<allowDetour>우회|돌아가|돌아갈|돌아도)"
)
_PRESENCE_KEYS = {"suitcase", "stroller"}
_COORDINATOR = re.compile(r"(?:\s|와|과|랑|이랑|및|하고|,|도|은|는)+")
_UNCERTAIN = re.compile(
    r"[?？]|나요|까요|일까|인가요|있는지|없는지"
    r"|아마|혹시|만약|경우|수도|일지도|모르|듯"
    r"|것\s*같|거\s*같|[가-힣]+면"
    r"|어제|그제|예전|지난|과거|전에는"
    r"|있었|없었|피곤했|힘들었|지쳤었|다쳤었|아팠"
)
_DOUBLE_NEGATIVE = re.compile(
    r"없지(?:는|도)?\s*않|없진\s*않|안\s*없|없[^.!?]{0,12}아니"
    r"|안[^.!?]{0,15}않|않[^.!?]{0,12}아니|싫지\s*않"
)
_PRESENCE_NEGATIVE = re.compile(
    r"없"
    r"|(?:안|못)\s*(?:(?:가지고|갖고|들고|끌고|쓰고|사용하고|이용하고|밀고)\s*있"
    r"|가지|갖|가져|들|끌|쓰|써|사용|이용|밀|있)"
    r"|(?:있|가지|갖|가져|들|끌|쓰|써|사용|이용|밀)[가-힣\s]{0,10}지\s*않"
)
_PRESENCE_POSITIVE = re.compile(r"있|가지|가져|갖|들고|들어|끌|쓰|써|사용|이용|밀고|무거|무겁")
_INJURY_NEGATIVE = re.compile(
    r"(?:안|못)\s*(?:다쳤|다치|아파|아프|불편)"
    r"|(?:다쳤|다치|아파|아프|불편)[가-힣\s]{0,8}지\s*않"
    r"|(?:다친|아픈|불편한)\s*(?:건|것은|것이)\s*아니"
    r"|(?:통증|부상|불편함|아픔)[가-힣\s]{0,8}없"
    r"|괜찮|멀쩡|다\s*나았|회복"
)
_INJURY_POSITIVE = re.compile(r"다쳤|다치|아파|아프|부상|통증|불편")
_TIRED_NEGATIVE = re.compile(
    r"안\s*(?:피곤|지쳤|지치|힘들)[가-힣]*"
    r"|(?:피곤|지쳤|지치|힘들)[가-힣\s]{0,10}(?:않|아니)"
    r"|피곤\s*안\s*하"
)
_TIRED_POSITIVE = re.compile(r"피곤|지쳤|지치|힘들")
_STAIRS_NEGATIVE = re.compile(
    r"(?:피할|피해야|피하고|회피할)\s*필요\s*(?:가|는|도)?\s*없"
    r"|피하지\s*않|안\s*피(?:하|할|해)|회피하지\s*않|회피\s*안"
    r"|피하고\s*싶지\s*않|괜찮|상관\s*없"
    r"|안\s*(?:힘들|어려|부담)|(?:힘들|어렵|부담)[가-힣\s]{0,8}않"
    r"|(?:이용|올라가|올라도|가도)[가-힣\s]{0,6}(?:돼|되)"
)
_STAIRS_POSITIVE = re.compile(
    r"피하|피할|피해|회피|없이|싫|힘들|어려|부담"
    r"|(?:안|못)\s*(?:가|오르|올라)|안\s*(?:돼|되)"
)
_DETOUR_NEGATIVE = re.compile(
    r"싶지\s*않|원하지\s*않|하지\s*않|안\s*돌아|안\s*우회"
    r"|안\s*(?:돼|되|해)|불가|금지|싫|필요\s*(?:가)?\s*없"
    r"|괜찮지\s*않|좋지\s*않|가능하지\s*않|허용하지\s*않"
)
_DETOUR_POSITIVE = re.compile(
    r"괜찮|허용|가능|좋|원해|싶|상관\s*없|해도\s*(?:돼|되)|가도\s*(?:돼|되)|해주세요"
)


@dataclass(frozen=True)
class _Mention:
    key: str
    term: str
    start: int
    end: int


def validate_text(text: str) -> str:
    """모든 공백을 제외한 1~500자를 확인하고 정리한 문자열을 반환한다."""
    if not isinstance(text, str):
        raise InvalidTextError(_INVALID_TEXT_MESSAGE)
    if not 1 <= len(_WHITESPACE.sub("", text)) <= 500:
        raise InvalidTextError(_INVALID_TEXT_MESSAGE)
    return _WHITESPACE.sub(" ", text).strip()


def _negative_or_positive(context: str, negative: re.Pattern, positive: re.Pattern):
    """부정 표현을 제거한 뒤에도 긍정이 남으면 모호한 진술로 처리한다."""
    has_negative = negative.search(context) is not None
    remaining = negative.sub("", context)
    has_positive = positive.search(remaining) is not None
    if has_negative and has_positive:
        return None
    if has_negative:
        return False
    return True if has_positive else None


def _classify(key: str, term: str, context: str):
    if _UNCERTAIN.search(context) or _DOUBLE_NEGATIVE.search(context):
        return None
    if key in _PRESENCE_KEYS:
        value = _negative_or_positive(context, _PRESENCE_NEGATIVE, _PRESENCE_POSITIVE)
        if value is None and not _PRESENCE_NEGATIVE.search(context):
            remainder = context.replace(term, "", 1)
            if re.fullmatch(r"[\s은는이가을를도와과랑.!。;]*", remainder):
                return True
        return value
    if key == "injuredLeg":
        if term == "목발" and _PRESENCE_NEGATIVE.search(context):
            # 보조도구가 없거나 안 쓴다는 말만으로 부상 유무를 확정하지 않는다.
            return None
        if re.search(r"안\s*괜찮|괜찮지\s*않|멀쩡하지\s*않", context):
            return None
        value = _negative_or_positive(context, _INJURY_NEGATIVE, _INJURY_POSITIVE)
        if value is None and term == "목발" and not _INJURY_NEGATIVE.search(context):
            return True
        return value
    if key == "tired":
        return _negative_or_positive(context, _TIRED_NEGATIVE, _TIRED_POSITIVE)
    if key == "avoidStairs":
        if re.search(r"못\s*피(?:하|해|할)|피(?:하|해|할)[가-힣\s]{0,8}수\s*없", context):
            return None
        return _negative_or_positive(context, _STAIRS_NEGATIVE, _STAIRS_POSITIVE)
    if key == "allowDetour":
        return _negative_or_positive(context, _DETOUR_NEGATIVE, _DETOUR_POSITIVE)
    return None


def _local_prefix(prefix: str) -> str:
    # 앞 상태의 부정·시제는 이어지는 상태로 전파하지 않는다.
    return re.split(r"(?:지만|는데|고|며|요|습니다|니다)\s*", prefix)[-1]


def parse_today(text: str) -> dict:
    """확인된 조건만 반환하며, 인식 실패를 False로 채우지 않는다."""
    normalized = validate_text(text)
    values: dict[str, list[bool | None]] = {}
    recognized_terms: list[str] = []

    for sentence in re.split(r"(?<=[.!?。！？;])", normalized):
        mentions = [
            _Mention(match.lastgroup, _WHITESPACE.sub("", match.group()), match.start(), match.end())
            for match in _KEYWORDS.finditer(sentence)
        ]
        index = 0
        while index < len(mentions):
            end_index = index
            while (
                end_index + 1 < len(mentions)
                and mentions[end_index].key in _PRESENCE_KEYS
                and mentions[end_index + 1].key in _PRESENCE_KEYS
                and _COORDINATOR.fullmatch(
                    sentence[mentions[end_index].end:mentions[end_index + 1].start]
                )
            ):
                end_index += 1

            start_position = mentions[index - 1].end if index else 0
            end_position = mentions[end_index + 1].start if end_index + 1 < len(mentions) else len(sentence)
            prefix = _local_prefix(sentence[start_position:mentions[index].start])
            suffix = sentence[mentions[end_index].end:end_position]
            for mention in mentions[index:end_index + 1]:
                if mention.term not in recognized_terms:
                    recognized_terms.append(mention.term)
                context = prefix + mention.term + suffix
                value = _classify(mention.key, mention.term, context)
                values.setdefault(mention.key, []).append(value)
            index = end_index + 1

    today = {}
    has_uncertain = False
    for key, observations in values.items():
        if None in observations or len(set(observations)) != 1:
            has_uncertain = True
        else:
            today[key] = observations[0]

    warnings = []
    if has_uncertain:
        warnings.append(_UNCERTAIN_WARNING)
    elif not recognized_terms:
        warnings.append(_UNKNOWN_WARNING)
    return {
        "today": today,
        "recognizedTerms": recognized_terms,
        "warnings": warnings,
        "requiresConfirmation": True,
        "parserMethod": "rules",
    }
