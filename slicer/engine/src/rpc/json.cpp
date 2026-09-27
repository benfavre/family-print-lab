#include "json.hpp"

#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <locale>
#include <sstream>

namespace printlab {

namespace {

const Json NULL_JSON;

// Floating to_chars only arrived in Apple's libc++ with macOS 13.3. Keep older desktop systems
// working without depending on the process locale or truncating a double to six decimal places.
// Pick the first precision which reads back exactly; max_digits10 always preserves a finite value.
[[maybe_unused]] std::string portable_number(double value) {
	std::string result;
	for (int precision = 1; precision <= std::numeric_limits<double>::max_digits10; ++precision) {
		std::ostringstream out;
		out.imbue(std::locale::classic());
		out.precision(precision);
		out << value;
		result = out.str();
		std::istringstream in(result);
		in.imbue(std::locale::classic());
		double round_trip = 0;
		if ((in >> round_trip) && round_trip == value) break;
	}
	return result;
}

struct Parser {
	const std::string &s;
	size_t i = 0;
	int depth = 0;

	[[noreturn]] void fail(const char *what) const {
		throw Json::ParseError(std::string(what) + " at offset " + std::to_string(i));
	}
	void ws() {
		while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r'))
			++i;
	}
	bool eat(const char *word) {
		size_t n = std::char_traits<char>::length(word);
		if (s.compare(i, n, word) != 0) return false;
		i += n;
		return true;
	}

	Json value() {
		ws();
		if (i >= s.size()) fail("unexpected end");
		if (++depth > 256) fail("nested too deeply");
		Json out;
		char c = s[i];
		if (c == '{') out = object();
		else if (c == '[') out = array();
		else if (c == '"') out = Json(string());
		else if (eat("true")) out = Json(true);
		else if (eat("false")) out = Json(false);
		else if (eat("null")) out = Json();
		else if (c == '-' || (c >= '0' && c <= '9')) out = number();
		else fail("unexpected character");
		--depth;
		return out;
	}

	Json object() {
		++i; // {
		Json::Object o;
		ws();
		if (i < s.size() && s[i] == '}') {
			++i;
			return Json(std::move(o));
		}
		for (;;) {
			ws();
			if (i >= s.size() || s[i] != '"') fail("expected a key");
			std::string key = string();
			ws();
			if (i >= s.size() || s[i] != ':') fail("expected ':'");
			++i;
			o[key] = value();
			ws();
			if (i < s.size() && s[i] == ',') {
				++i;
				continue;
			}
			if (i < s.size() && s[i] == '}') {
				++i;
				return Json(std::move(o));
			}
			fail("expected ',' or '}'");
		}
	}

	Json array() {
		++i; // [
		Json::Array a;
		ws();
		if (i < s.size() && s[i] == ']') {
			++i;
			return Json(std::move(a));
		}
		for (;;) {
			a.push_back(value());
			ws();
			if (i < s.size() && s[i] == ',') {
				++i;
				continue;
			}
			if (i < s.size() && s[i] == ']') {
				++i;
				return Json(std::move(a));
			}
			fail("expected ',' or ']'");
		}
	}

	unsigned hex4() {
		if (i + 4 > s.size()) fail("short \\u escape");
		unsigned v = 0;
		for (int k = 0; k < 4; ++k) {
			char c = s[i++];
			v <<= 4;
			if (c >= '0' && c <= '9') v |= unsigned(c - '0');
			else if (c >= 'a' && c <= 'f') v |= unsigned(c - 'a' + 10);
			else if (c >= 'A' && c <= 'F') v |= unsigned(c - 'A' + 10);
			else fail("bad \\u escape");
		}
		return v;
	}

	static void utf8(std::string &out, unsigned cp) {
		if (cp < 0x80) out += char(cp);
		else if (cp < 0x800) {
			out += char(0xC0 | (cp >> 6));
			out += char(0x80 | (cp & 0x3F));
		} else if (cp < 0x10000) {
			out += char(0xE0 | (cp >> 12));
			out += char(0x80 | ((cp >> 6) & 0x3F));
			out += char(0x80 | (cp & 0x3F));
		} else {
			out += char(0xF0 | (cp >> 18));
			out += char(0x80 | ((cp >> 12) & 0x3F));
			out += char(0x80 | ((cp >> 6) & 0x3F));
			out += char(0x80 | (cp & 0x3F));
		}
	}

	std::string string() {
		++i; // "
		std::string out;
		for (;;) {
			if (i >= s.size()) fail("unterminated string");
			char c = s[i++];
			if (c == '"') return out;
			if (static_cast<unsigned char>(c) < 0x20) fail("control character in string");
			if (c != '\\') {
				out += c;
				continue;
			}
			if (i >= s.size()) fail("unterminated escape");
			char e = s[i++];
			switch (e) {
			case '"': out += '"'; break;
			case '\\': out += '\\'; break;
			case '/': out += '/'; break;
			case 'b': out += '\b'; break;
			case 'f': out += '\f'; break;
			case 'n': out += '\n'; break;
			case 'r': out += '\r'; break;
			case 't': out += '\t'; break;
			case 'u': {
				unsigned cp = hex4();
				if (cp >= 0xD800 && cp <= 0xDBFF) {
					if (!eat("\\u")) fail("lone surrogate");
					unsigned lo = hex4();
					if (lo < 0xDC00 || lo > 0xDFFF) fail("bad surrogate pair");
					cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
				}
				utf8(out, cp);
				break;
			}
			default: fail("unknown escape");
			}
		}
	}

	Json number() {
		size_t start = i;
		if (s[i] == '-') ++i;
		if (i >= s.size() || !(s[i] >= '0' && s[i] <= '9')) fail("bad number");
		if (s[i] == '0') ++i;
		else
			while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
		if (i < s.size() && s[i] == '.') {
			++i;
			if (i >= s.size() || !(s[i] >= '0' && s[i] <= '9')) fail("bad fraction");
			while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
		}
		if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
			++i;
			if (i < s.size() && (s[i] == '+' || s[i] == '-')) ++i;
			if (i >= s.size() || !(s[i] >= '0' && s[i] <= '9')) fail("bad exponent");
			while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
		}
		// main.cpp sets LC_NUMERIC to "C", so strtod reads '.' as the decimal point.
		return Json(std::strtod(s.substr(start, i - start).c_str(), nullptr));
	}
};

void escape(std::string &out, const std::string &s) {
	out += '"';
	for (unsigned char c : s) {
		switch (c) {
		case '"': out += "\\\""; break;
		case '\\': out += "\\\\"; break;
		case '\n': out += "\\n"; break;
		case '\r': out += "\\r"; break;
		case '\t': out += "\\t"; break;
		case '\b': out += "\\b"; break;
		case '\f': out += "\\f"; break;
		default:
			if (c < 0x20) {
				char buf[8];
				std::snprintf(buf, sizeof buf, "\\u%04x", c);
				out += buf;
			} else
				out += char(c);
		}
	}
	out += '"';
}

} // namespace

Json Json::parse(const std::string &text) {
	Parser p{text};
	Json v = p.value();
	p.ws();
	if (p.i != text.size()) p.fail("trailing characters");
	return v;
}

bool Json::as_bool() const {
	if (type_ != Type::Bool) throw TypeError("expected a boolean");
	return bool_;
}
double Json::as_number() const {
	if (type_ != Type::Number) throw TypeError("expected a number");
	return num_;
}
long long Json::as_int() const {
	double n = as_number();
	if (std::floor(n) != n || std::fabs(n) > 9007199254740992.0) throw TypeError("expected an integer");
	return static_cast<long long>(n);
}
const std::string &Json::as_string() const {
	if (type_ != Type::String) throw TypeError("expected a string");
	return str_;
}
const Json::Array &Json::as_array() const {
	if (type_ != Type::Array) throw TypeError("expected an array");
	return *arr_;
}
Json::Array &Json::as_array() {
	if (type_ != Type::Array) throw TypeError("expected an array");
	make_own();
	return *arr_;
}
const Json::Object &Json::as_object() const {
	if (type_ != Type::Object) throw TypeError("expected an object");
	return *obj_;
}
Json::Object &Json::as_object() {
	if (type_ != Type::Object) throw TypeError("expected an object");
	make_own();
	return *obj_;
}

void Json::make_own() {
	if (arr_ && arr_.use_count() > 1) arr_ = std::make_shared<Array>(*arr_);
	if (obj_ && obj_.use_count() > 1) obj_ = std::make_shared<Object>(*obj_);
}

const Json &Json::operator[](const std::string &key) const {
	if (type_ != Type::Object) return NULL_JSON;
	auto it = obj_->find(key);
	return it == obj_->end() ? NULL_JSON : it->second;
}
Json &Json::operator[](const std::string &key) {
	if (type_ == Type::Null) *this = object();
	return as_object()[key];
}
const Json &Json::operator[](size_t i) const {
	if (type_ != Type::Array || i >= arr_->size()) return NULL_JSON;
	return (*arr_)[i];
}
bool Json::has(const std::string &key) const {
	return type_ == Type::Object && obj_->count(key) > 0;
}
size_t Json::size() const {
	if (type_ == Type::Array) return arr_->size();
	if (type_ == Type::Object) return obj_->size();
	return 0;
}
void Json::push_back(Json v) {
	if (type_ == Type::Null) *this = array();
	as_array().push_back(std::move(v));
}

std::string Json::dump() const {
	std::string out;
	dump_to(out);
	return out;
}

void Json::dump_to(std::string &out) const {
	switch (type_) {
	case Type::Null: out += "null"; break;
	case Type::Bool: out += bool_ ? "true" : "false"; break;
	case Type::Number: {
		if (!std::isfinite(num_)) {
			out += "null";
			break;
		}
		char buf[40];
		if (std::round(num_) == num_ && std::fabs(num_) < 1e15) {
			std::snprintf(buf, sizeof buf, "%.0f", num_);
			out += buf;
			break;
		}
		// Apple marks this overload explicitly unavailable for deployment targets below 13.3,
		// so even a runtime __builtin_available guard cannot make it compile for older macOS.
#if !defined(PRINTLAB_JSON_FORCE_PORTABLE) && \
    (!defined(__APPLE__) || (defined(__ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__) && \
                            __ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__ >= 130300))
		auto r = std::to_chars(buf, buf + sizeof buf, num_);
		out.append(buf, r.ptr);
#else
		out += portable_number(num_);
#endif
		break;
	}
	case Type::String: escape(out, str_); break;
	case Type::Array: {
		out += '[';
		bool first = true;
		for (const Json &v : *arr_) {
			if (!first) out += ',';
			first = false;
			v.dump_to(out);
		}
		out += ']';
		break;
	}
	case Type::Object: {
		out += '{';
		bool first = true;
		for (const auto &kv : *obj_) {
			if (!first) out += ',';
			first = false;
			escape(out, kv.first);
			out += ':';
			kv.second.dump_to(out);
		}
		out += '}';
		break;
	}
	}
}

bool Json::operator==(const Json &o) const {
	if (type_ != o.type_) return false;
	switch (type_) {
	case Type::Null: return true;
	case Type::Bool: return bool_ == o.bool_;
	case Type::Number: return num_ == o.num_;
	case Type::String: return str_ == o.str_;
	case Type::Array: return *arr_ == *o.arr_;
	case Type::Object: return *obj_ == *o.obj_;
	}
	return false;
}

} // namespace printlab
